import type { OAuthTokens } from "../shared/constants.ts";
import {
  findAlternateCredentials,
  isExpiringSoon,
  readFreshCliCredentials,
  refreshViaClaudeCli,
} from "../shared/credentials.ts";
import { randomUUID } from "node:crypto";
import { accountProfile, deviceId } from "../shared/identity.ts";
import { awaitIntro } from "../shared/introspection.ts";
import { log } from "../shared/logger.ts";
import { refreshTokensOnce } from "../shared/oauthClient.ts";
import { addBetaParam, isInsecure, rewriteOrigin } from "../shared/proxy.ts";
import { isTerminalRateLimit } from "../shared/rateLimit.ts";
import { reportVersionGate } from "../shared/versionGate.ts";
import { applyOAuthHeaders, hasJsonContentType } from "../shared/request.ts";
import {
  transformRequestBody,
  withAccountMetadata,
  withUnprefixedToolNames,
  type BodyContext,
} from "../shared/transforms.ts";

export type AuthState = {
  type: string;
  access?: string;
  refresh?: string;
  expires?: number;
};

export type AuthStore = {
  auth: {
    set(input: {
      path: { id: string };
      body: { type: "oauth"; access: string; refresh: string; expires: number };
    }): Promise<object | void>;
  };
};

type PreparedBody = { body: BodyInit | null | undefined; modelId: string | null };

const recoverableStatuses = new Set([401, 429, 529]);

function mergeHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

function isTextBody(body: BodyInit | null | undefined): body is string {
  return typeof body === "string";
}

async function prepareBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  headers: Headers,
  context: BodyContext,
): Promise<PreparedBody> {
  if (isTextBody(init?.body)) return transformRequestBody(init.body, context);
  if (init?.body !== undefined || !(input instanceof Request) || !input.body) {
    return { body: init?.body, modelId: null };
  }

  if (!hasJsonContentType(headers))
    return { body: await input.clone().arrayBuffer(), modelId: null };
  return transformRequestBody(await input.clone().text(), context);
}

async function persistTokens(
  store: AuthStore,
  auth: AuthState,
  tokens: OAuthTokens,
): Promise<void> {
  await store.auth.set({ path: { id: "anthropic" }, body: { type: "oauth", ...tokens } });
  auth.access = tokens.access;
  auth.refresh = tokens.refresh;
  auth.expires = tokens.expires;
}

async function latestRefreshToken(
  auth: AuthState,
  getAuth: () => Promise<AuthState>,
): Promise<string | undefined> {
  try {
    const latest = await getAuth();
    if (latest.type === "oauth" && latest.refresh) return latest.refresh;
  } catch (failure) {
    log.debug("auth re-read failed, using snapshot", { error: String(failure) });
  }
  return auth.refresh;
}

async function refreshWithToken(refreshToken: string | undefined): Promise<OAuthTokens | null> {
  if (!refreshToken) return null;
  try {
    return await refreshTokensOnce(refreshToken);
  } catch (failure) {
    log.warn("oauth refresh failed, falling back to claude cli", { error: String(failure) });
    return null;
  }
}

async function refreshAuth(
  auth: AuthState,
  store: AuthStore,
  getAuth: () => Promise<AuthState>,
): Promise<void> {
  const tokens =
    (await refreshWithToken(await latestRefreshToken(auth, getAuth))) ??
    (await readFreshCliCredentials());
  if (!tokens) {
    log.error("all refresh methods failed");
    return;
  }
  await persistTokens(store, auth, tokens);
}

async function recoverCredentials(auth: AuthState, status: number): Promise<OAuthTokens | null> {
  const alternate = await findAlternateCredentials(auth.refresh ?? "");
  if (alternate) return alternate;
  if (status !== 401) return null;

  const triggered = await refreshViaClaudeCli();
  return triggered && !isExpiringSoon(triggered.expires) ? triggered : null;
}

async function retryWithRecoveredCredentials(
  response: Response,
  auth: AuthState,
  store: AuthStore,
  input: RequestInfo | URL,
  init: BunFetchRequestInit,
): Promise<Response> {
  const body = await response.text().catch(() => "");
  const original = () =>
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

  if (isTerminalRateLimit(response.status, body)) {
    log.warn("terminal rate limit, not retrying", { status: response.status });
    return original();
  }

  log.info("attempting credential recovery", { status: response.status });
  const tokens = await recoverCredentials(auth, response.status);
  if (!tokens) return original();

  await persistTokens(store, auth, tokens);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${tokens.access}`);
  log.info("retrying with recovered credentials");
  const retryBody = isTextBody(init.body)
    ? withAccountMetadata(init.body, (await accountProfile(tokens.access))?.uuid ?? null)
    : init.body;
  const retryInit: BunFetchRequestInit = { ...init, headers, body: retryBody };
  return reportVersionGate(await fetch(input, retryInit));
}

function unauthenticated(): Response {
  return new Response(JSON.stringify({ error: "authentication_failed" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

async function bodyContext(sessionId: string, access: string): Promise<BodyContext> {
  const [device, profile] = await Promise.all([deviceId(), accountProfile(access)]);
  return { sessionId, deviceId: device, accountUuid: profile?.uuid ?? null };
}

export function createCustomFetch(getAuth: () => Promise<AuthState>, store: AuthStore) {
  const sessionId = randomUUID();
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const intro = await awaitIntro();
    const auth = await getAuth();
    if (auth.type !== "oauth") return fetch(input, init);

    if (!auth.access || !auth.expires || isExpiringSoon(auth.expires)) {
      await refreshAuth(auth, store, getAuth);
    }
    if (!auth.access) {
      log.error("no valid access token after refresh attempts");
      return unauthenticated();
    }

    const headers = mergeHeaders(input, init);
    const context = await bodyContext(sessionId, auth.access);
    const { body, modelId } = await prepareBody(input, init, headers, context);
    applyOAuthHeaders(headers, modelId, { access: auth.access, sessionId, cli: intro });

    const target = addBetaParam(rewriteOrigin(input));
    const requestInit: BunFetchRequestInit = { ...init, body, headers };
    if (isInsecure()) requestInit.tls = { rejectUnauthorized: false };
    log.debug("outgoing request", { model: modelId });

    const response = await reportVersionGate(await fetch(target, requestInit));
    const final = recoverableStatuses.has(response.status)
      ? await retryWithRecoveredCredentials(response, auth, store, target, requestInit)
      : response;
    return withUnprefixedToolNames(final);
  };
}
