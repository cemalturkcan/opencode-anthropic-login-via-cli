import type { OAuthTokens } from "./constants.ts";
import { log } from "./logger.ts";
import { getIntro } from "./introspection.ts";
import { getBetasForModel, getBetaFlags } from "./model-config.ts";
import {
  getCurrentRefreshToken,
  setCurrentRefreshToken,
  clearRefreshInFlight,
  refreshTokensSafe,
  readClaudeCodeCredentials,
  refreshViaClaudeCli,
  findAlternateCredentials,
  isExpiringSoon,
} from "./credentials.ts";
import { transformRequestBody, createToolNameUnprefixStream } from "./transforms.ts";

interface AuthState {
  type: string;
  access?: string;
  refresh?: string;
  expires?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientApi = any;

function isLongContextError(body: string): boolean {
  return (
    body.includes("Extra usage is required for long context requests") ||
    body.includes("extra_usage") ||
    body.includes("usage_limit_exceeded")
  );
}

function isBillingError(body: string): boolean {
  return body.includes("billing_error");
}

export function createCustomFetch(getAuth: () => Promise<AuthState>, client: ClientApi) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { userAgent, betaHeaders } = getIntro();
    const auth = await getAuth();
    if (auth.type !== "oauth") return fetch(input, init);

    if (auth.refresh && auth.refresh !== getCurrentRefreshToken()) {
      clearRefreshInFlight();
      setCurrentRefreshToken(auth.refresh);
      log.info("Account switch detected");
    }

    if (!auth.access || (auth.expires && auth.expires < Date.now() + 5 * 60 * 1000)) {
      await refreshAuth(auth, client);
    }

    const reqHeaders = buildHeaders(input, init);

    let body = init?.body;
    let modelId: string | null = null;

    if (body && typeof body === "string") {
      const transformed = transformRequestBody(body);
      body = transformed.body;
      modelId = transformed.modelId;
    }

    const baseBetas = getBetaFlags(betaHeaders);
    const modelBetas = modelId ? getBetasForModel(modelId, baseBetas) : baseBetas;

    const incoming = (reqHeaders.get("anthropic-beta") || "")
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    const merged = [...new Set([...modelBetas, ...incoming])].join(",");

    reqHeaders.set("authorization", `Bearer ${auth.access}`);
    reqHeaders.set("anthropic-beta", merged);
    reqHeaders.set("user-agent", userAgent);
    reqHeaders.set("x-app", "cli");
    reqHeaders.delete("x-api-key");

    const reqInput = addBetaParam(input);

    log.debug("Outgoing request", {
      model: modelId,
      betaCount: merged.split(",").length,
    });

    let response = await fetch(reqInput, {
      ...init,
      body,
      headers: reqHeaders,
    });

    if (response.status === 429 || response.status === 529 || response.status === 401) {
      response = await handleRetryableError(response, auth, client, reqInput, {
        ...init,
        body,
        headers: reqHeaders,
      });
    }

    if (response.body) {
      const reader = response.body.getReader();
      const stream = createToolNameUnprefixStream(reader);
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return response;
  };
}

function buildHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const reqHeaders = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((v: string, k: string) => reqHeaders.set(k, v));
  }

  if (init?.headers) {
    const h = init.headers;
    if (h instanceof Headers) {
      h.forEach((v: string, k: string) => reqHeaders.set(k, v));
    } else if (Array.isArray(h)) {
      for (const [k, v] of h) {
        if (v !== undefined) reqHeaders.set(k, String(v));
      }
    } else {
      for (const [k, v] of Object.entries(h as Record<string, string>)) {
        if (v !== undefined) reqHeaders.set(k, String(v));
      }
    }
  }

  return reqHeaders;
}

function addBetaParam(input: RequestInfo | URL): RequestInfo | URL {
  try {
    let reqUrl: URL | null = null;
    if (typeof input === "string" || input instanceof URL) {
      reqUrl = new URL(input.toString());
    } else if (input instanceof Request) {
      reqUrl = new URL(input.url);
    }
    if (reqUrl?.pathname === "/v1/messages" && !reqUrl.searchParams.has("beta")) {
      reqUrl.searchParams.set("beta", "true");
      return input instanceof Request ? new Request(reqUrl.toString(), input) : reqUrl;
    }
  } catch {}
  return input;
}

async function refreshAuth(auth: AuthState, client: ClientApi): Promise<void> {
  let refreshed = false;

  try {
    const fresh = await refreshTokensSafe(auth.refresh!);
    await client.auth.set({
      path: { id: "anthropic" },
      body: {
        type: "oauth",
        refresh: fresh.refresh,
        access: fresh.access,
        expires: fresh.expires,
      },
    });
    auth.access = fresh.access;
    auth.refresh = fresh.refresh;
    auth.expires = fresh.expires;
    refreshed = true;
    log.info("Proactive token refresh succeeded (OAuth)");
  } catch (e) {
    log.warn("OAuth refresh failed, trying fallbacks", {
      error: String(e),
    });
  }

  if (!refreshed) {
    let kc = await readClaudeCodeCredentials();
    if (!kc || isExpiringSoon(kc.expires)) {
      kc = await refreshViaClaudeCli();
    }
    if (kc && !isExpiringSoon(kc.expires)) {
      clearRefreshInFlight();
      setCurrentRefreshToken(kc.refresh);
      await client.auth.set({
        path: { id: "anthropic" },
        body: { type: "oauth", ...kc },
      });
      auth.access = kc.access;
      auth.refresh = kc.refresh;
      auth.expires = kc.expires;
      refreshed = true;
      log.info("Proactive token refresh succeeded (CLI credentials)");
    }
  }

  if (!refreshed) {
    try {
      const kc = await refreshViaClaudeCli();
      if (kc && !isExpiringSoon(kc.expires)) {
        await client.auth.set({
          path: { id: "anthropic" },
          body: { type: "oauth", ...kc },
        });
        auth.access = kc.access;
        auth.refresh = kc.refresh;
        auth.expires = kc.expires;
        log.info("Proactive token refresh succeeded (CLI trigger)");
      }
    } catch (e) {
      log.error("All refresh methods failed", { error: String(e) });
    }
  }
}

async function handleRetryableError(
  response: Response,
  auth: AuthState,
  client: ClientApi,
  reqInput: RequestInfo | URL,
  reqInit: RequestInit,
): Promise<Response> {
  let responseBody = "";
  try {
    responseBody = await response.text();
  } catch {}

  // long context and billing 429s are not fixable by swapping credentials
  if (
    response.status === 429 &&
    (isLongContextError(responseBody) || isBillingError(responseBody))
  ) {
    log.warn("Non-retryable 429: long context or billing error", {
      status: response.status,
      isLongContext: isLongContextError(responseBody),
      isBilling: isBillingError(responseBody),
    });
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  log.info("Attempting recovery for error response", {
    status: response.status,
  });

  let freshCreds: OAuthTokens | null = null;

  freshCreds = await findAlternateCredentials(auth.refresh!);

  if (!freshCreds && response.status === 401) {
    freshCreds = await refreshViaClaudeCli();
  }

  if (freshCreds && !isExpiringSoon(freshCreds.expires)) {
    clearRefreshInFlight();
    setCurrentRefreshToken(freshCreds.refresh);
    await client.auth.set({
      path: { id: "anthropic" },
      body: { type: "oauth", ...freshCreds },
    });

    const headers = new Headers(reqInit.headers);
    headers.set("authorization", `Bearer ${freshCreds.access}`);

    log.info("Retrying with fresh credentials");
    return fetch(reqInput, { ...reqInit, headers });
  }

  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
