import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import type { Plugin as V2Plugin } from "@opencode/plugin";
import { discoverCCSInstances } from "./shared/credentials.ts";
import { startIntro } from "./shared/introspection.ts";
import { log } from "./shared/logger.ts";
import { createV1Auth } from "./v1/auth.ts";
import { setupV2Auth } from "./v2/auth.ts";

async function bootstrap(runtime: string) {
  log.info("plugin initializing", { runtime });
  startIntro();
  return discoverCCSInstances();
}

export const server: V1Plugin = async ({ client }) => ({
  auth: createV1Auth(client, await bootstrap("v1")),
});

export async function setup(ctx: V2Plugin.Context): Promise<void> {
  await setupV2Auth(ctx, await bootstrap("v2"));
}

export const plugin: V2Plugin.Plugin & { server: V1Plugin } = {
  id: "opencode-anthropic-login-via-cli",
  server,
  setup,
};
