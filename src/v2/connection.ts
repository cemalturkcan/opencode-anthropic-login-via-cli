import type { Credential, Plugin as V2Plugin } from "@opencode/plugin";
import { log } from "../shared/logger.ts";

export type IntegrationAccess = Pick<V2Plugin.Context["integration"], "connection">;

export async function resolveOAuthCredential(
  integration: IntegrationAccess,
): Promise<Credential.OAuth | undefined> {
  try {
    const connection = await integration.connection.active("anthropic");
    if (!connection) return undefined;
    const credential = await integration.connection.resolve(connection);
    return credential?.type === "oauth" ? credential : undefined;
  } catch (failure) {
    log.warn("failed to resolve anthropic connection", { error: String(failure) });
    return undefined;
  }
}
