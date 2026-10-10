import { beforeEach, describe, expect, it } from "bun:test";
import { createV2Context } from "./testing/v2Context.ts";
import { resetSandbox } from "./testing/fixtures.ts";
import plugin from "./index.ts";

beforeEach(resetSandbox);

describe("plugin export", () => {
  it("identifies the plugin for V2", () => {
    expect(plugin.id).toBe("opencode-anthropic-login-via-cli");
  });

  it("registers the anthropic auth hook on V1", async () => {
    const hooks = await plugin.server({ client: { auth: { set: async () => ({}) } } } as never);

    expect(hooks.auth?.provider).toBe("anthropic");
  });

  it("registers the anthropic methods and http hooks on V2", async () => {
    const v2 = createV2Context(undefined);

    await plugin.setup(v2.context);

    expect([...v2.methods.keys()]).toContain("claude-cli");
    expect([...v2.hooks.keys()]).toEqual(["http.request", "http.response"]);
  });
});
