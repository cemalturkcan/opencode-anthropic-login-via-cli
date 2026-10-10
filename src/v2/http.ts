import type { Plugin as V2Plugin } from "@opencode/plugin";
import { awaitIntro } from "../shared/introspection.ts";
import { log } from "../shared/logger.ts";
import { addBetaParam, rewriteOrigin } from "../shared/proxy.ts";
import { applyOAuthHeaders, hasJsonContentType } from "../shared/request.ts";
import { transformRequestBody, withUnprefixedToolNames } from "../shared/transforms.ts";
import { resolveOAuthCredential, type IntegrationAccess } from "./connection.ts";
import type { SubscriptionPricing } from "./pricing.ts";

type SessionAccess = Pick<V2Plugin.Context["session"], "hook">;
type TransformedBody = { body: string | undefined; modelId: string | null };

async function transformJsonBody(request: Request): Promise<TransformedBody> {
  if (!request.body || !hasJsonContentType(request.headers))
    return { body: undefined, modelId: null };
  try {
    return transformRequestBody(await request.clone().text());
  } catch (failure) {
    if (request.signal.aborted) throw failure;
    log.warn("failed to read request body for transformation", { error: String(failure) });
    return { body: undefined, modelId: null };
  }
}

export async function prepareOAuthRequest(request: Request, access: string): Promise<Request> {
  const intro = await awaitIntro();
  const { body, modelId } = await transformJsonBody(request);
  const headers = new Headers(request.headers);
  applyOAuthHeaders(headers, access, modelId, intro);

  const init: RequestInit = { headers };
  if (body !== undefined) {
    init.body = body;
    headers.delete("content-length");
  }
  return rewriteOrigin(addBetaParam(new Request(request, init)));
}

export async function setupV2Http(
  integration: IntegrationAccess,
  session: SessionAccess,
  pricing: SubscriptionPricing,
): Promise<void> {
  await session.hook(
    "http.request",
    async (event) => {
      const credential = await resolveOAuthCredential(integration);
      await pricing.sync(credential !== undefined);
      if (!credential) return;
      event.request = await prepareOAuthRequest(event.request, credential.access);
    },
    { providerID: "anthropic" },
  );

  await session.hook(
    "http.response",
    async (event) => {
      if (!(await resolveOAuthCredential(integration))) return;
      event.response = withUnprefixedToolNames(event.response);
    },
    { providerID: "anthropic" },
  );
}
