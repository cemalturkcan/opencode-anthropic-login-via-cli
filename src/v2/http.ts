import { randomUUID } from "node:crypto";
import type { Plugin as V2Plugin } from "@opencode/plugin";
import { accountProfile, deviceId } from "../shared/identity.ts";
import { awaitIntro } from "../shared/introspection.ts";
import { log } from "../shared/logger.ts";
import { addBetaParam, rewriteOrigin } from "../shared/proxy.ts";
import { isTerminalRateLimit, rateLimitResetAt } from "../shared/rateLimit.ts";
import { applyOAuthHeaders, hasJsonContentType } from "../shared/request.ts";
import {
  transformRequestBody,
  withAccountMetadata,
  withUnprefixedToolNames,
  type BodyContext,
} from "../shared/transforms.ts";
import { reportVersionGate } from "../shared/versionGate.ts";
import type { AccountRouter, SelectedAccount } from "./accounts.ts";
import type { SubscriptionPricing } from "./pricing.ts";

type SessionAccess = Pick<V2Plugin.Context["session"], "hook">;
type TransformedBody = { body: string | undefined; modelId: string | null };
type SentRequest = { account: SelectedAccount; body: string | undefined };

async function transformJsonBody(request: Request, context: BodyContext): Promise<TransformedBody> {
  if (!request.body || !hasJsonContentType(request.headers)) {
    return { body: undefined, modelId: null };
  }
  try {
    return transformRequestBody(await request.clone().text(), context);
  } catch (failure) {
    if (request.signal.aborted) throw failure;
    log.warn("failed to read request body for transformation", { error: String(failure) });
    return { body: undefined, modelId: null };
  }
}

async function bodyContext(sessionId: string, access: string): Promise<BodyContext> {
  const [device, profile] = await Promise.all([deviceId(), accountProfile(access)]);
  return { sessionId, deviceId: device, accountUuid: profile?.uuid ?? null };
}

export async function prepareOAuthRequest(
  request: Request,
  access: string,
  sessionId: string,
): Promise<{ request: Request; body: string | undefined }> {
  const cli = await awaitIntro();
  const { body, modelId } = await transformJsonBody(request, await bodyContext(sessionId, access));
  const headers = new Headers(request.headers);
  applyOAuthHeaders(headers, modelId, { access, sessionId, cli });

  const init: RequestInit = { headers };
  if (body !== undefined) {
    init.body = body;
    headers.delete("content-length");
  }
  return { request: addBetaParam(rewriteOrigin(new Request(request, init))), body };
}

async function replayWith(sent: Request, body: string, access: string): Promise<Request> {
  const headers = new Headers(sent.headers);
  headers.set("authorization", `Bearer ${access}`);
  headers.delete("content-length");
  const accountUuid = (await accountProfile(access))?.uuid ?? null;
  return new Request(sent.url, {
    method: sent.method,
    headers,
    body: withAccountMetadata(body, accountUuid),
    signal: sent.signal,
  });
}

export async function setupV2Http(
  router: AccountRouter,
  session: SessionAccess,
  pricing: SubscriptionPricing,
): Promise<void> {
  const sessionIds = new Map<string, string>();
  const sentRequests = new WeakMap<Request, SentRequest>();

  const claudeSessionId = (sessionID: string) => {
    const existing = sessionIds.get(sessionID);
    if (existing) return existing;
    const created = randomUUID();
    sessionIds.set(sessionID, created);
    return created;
  };

  async function failover(response: Response, sent: Request, record: SentRequest) {
    if (response.status !== 429 || record.body === undefined) return response;
    if (isTerminalRateLimit(429, await response.clone().text())) return response;

    const alternative = await router.failover(record.account, rateLimitResetAt(response.headers));
    if (!alternative) return response;
    await response.body?.cancel();
    return reportVersionGate(
      await fetch(await replayWith(sent, record.body, alternative.credential.access)),
    );
  }

  await session.hook(
    "http.request",
    async (event) => {
      const sessionID = String(event.sessionID);
      const account = await router.select();
      await pricing.sync(account !== undefined);
      if (!account) return;

      const prepared = await prepareOAuthRequest(
        event.request,
        account.credential.access,
        claudeSessionId(sessionID),
      );
      sentRequests.set(prepared.request, { account, body: prepared.body });
      event.request = prepared.request;
    },
    { providerID: "anthropic" },
  );

  await session.hook(
    "http.response",
    async (event) => {
      const record = sentRequests.get(event.request);
      if (record) {
        const response = await failover(
          await reportVersionGate(event.response),
          event.request,
          record,
        );
        event.response = withUnprefixedToolNames(response);
        return;
      }

      if (!(await router.select())) return;
      log.debug("response request was not the prepared request, skipping account failover");
      event.response = withUnprefixedToolNames(await reportVersionGate(event.response));
    },
    { providerID: "anthropic" },
  );
}
