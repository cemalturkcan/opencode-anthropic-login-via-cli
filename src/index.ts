import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import type { Plugin as V2Plugin } from "@opencode/plugin";
import { log } from "./logger.ts";
import { discoverCCSInstances } from "./credentials.ts";
import { startIntro } from "./introspection.ts";
import { createV1Auth } from "./v1-auth.ts";
import { setupV2Auth } from "./v2-auth.ts";

const server: V1Plugin = async ({ client }) => {
  log.info("Plugin initializing");
  startIntro();

  const ccsInstances = await discoverCCSInstances();
  log.info("Discovered CCS instances", { count: ccsInstances.length });

  return { auth: createV1Auth(client, ccsInstances) };
};

const plugin: V2Plugin.Plugin & { server: V1Plugin } = {
  id: "opencode-anthropic-login-via-cli",
  server,
  setup: setupV2Auth,
};

export default plugin;
