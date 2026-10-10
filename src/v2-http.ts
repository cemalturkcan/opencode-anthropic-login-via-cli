import type { Credential, Plugin as V2Plugin } from "@opencode/plugin";
import { addBetaParam } from "./fetch.ts";
import { awaitIntro } from "./introspection.ts";
import { getBetaFlags, getBetasForModel } from "./model-config.ts";
import { log } from "./logger.ts";
import { rewriteOrigin } from "./proxy.ts";
import { createToolNameUnprefixStream, transformRequestBody } from "./transforms.ts";

type Context = Pick<V2Plugin.Context, "integration" | "session">;
type OAuthCredential = Credential.OAuth;

export async function setupV2Http(ctx: Context): Promise<void> {
  const getOAuthCredential = async (): Promise<OAuthCredential | undefined> => {
    try {
      const connection = await ctx.integration.connection.active("anthropic");
      if (!connection) return;
      const credential = await ctx.integration.connection.resolve(connection);
      return credential?.type === "oauth" ? credential : undefined;
    } catch (error) {
      log.warn("Failed to resolve Anthropic OAuth credential for HTTP hook", {
        error: String(error),
      });
    }
  };

  await ctx.session.hook(
    "http.request",
    async (event) => {
      const credential = await getOAuthCredential();
      if (!credential) return;

      const { userAgent, betaHeaders } = await awaitIntro();
      const request = event.request;
      const headers = new Headers(request.headers);
      let body: string | undefined;
      let modelID: string | null = null;

      if (request.body && headers.get("content-type")?.toLowerCase().includes("application/json")) {
        try {
          const transformed = transformRequestBody(await request.clone().text());
          body = transformed.body;
          modelID = transformed.modelId;
        } catch (error) {
          if (request.signal.aborted) throw error;
          log.warn("Failed to read V2 request body for transformation", { error: String(error) });
        }
      }

      const baseBetas = getBetaFlags(betaHeaders);
      const betas = modelID ? getBetasForModel(modelID, baseBetas) : baseBetas;
      const incomingBetas = (headers.get("anthropic-beta") || "")
        .split(",")
        .map((beta) => beta.trim())
        .filter(Boolean);

      headers.set("authorization", `Bearer ${credential.access}`);
      headers.set("anthropic-beta", [...new Set([...betas, ...incomingBetas])].join(","));
      headers.set("user-agent", userAgent);
      headers.set("x-app", "cli");
      headers.delete("x-api-key");

      const updated = new Request(request, {
        headers,
        signal: request.signal,
        ...(body === undefined ? {} : { body }),
      });
      const withBeta = addBetaParam(updated);
      event.request = rewriteOrigin(withBeta) as Request;
    },
    { providerID: "anthropic" },
  );

  await ctx.session.hook(
    "http.response",
    async (event) => {
      if (!(await getOAuthCredential())) return;
      if (
        !event.response.body ||
        !event.response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
      ) {
        return;
      }

      const reader = event.response.body.getReader();
      event.response = new Response(createToolNameUnprefixStream(reader), {
        status: event.response.status,
        statusText: event.response.statusText,
        headers: event.response.headers,
      });
    },
    { providerID: "anthropic" },
  );
}
