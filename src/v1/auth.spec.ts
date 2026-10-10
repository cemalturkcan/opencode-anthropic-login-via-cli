import { beforeEach, describe, expect, it } from "bun:test";
import type { AuthHook } from "@opencode-ai/plugin";
import { replaceFetch, restoreFetchAfterEach, tokenResponse } from "../testing/fetch.ts";
import {
  installClaudeStub,
  resetSandbox,
  validTokens,
  writeCcsInstance,
  writeCliCredentials,
} from "../testing/fixtures.ts";
import { createV1Auth, zeroModelCosts } from "./auth.ts";
import type { AuthStore } from "./fetch.ts";

type OAuthMethod = Extract<AuthHook["methods"][number], { type: "oauth" }>;
type Loader = NonNullable<AuthHook["loader"]>;

restoreFetchAfterEach();
beforeEach(resetSandbox);

const store: AuthStore = { auth: { set: async () => undefined } };

function oauthMethod(auth: AuthHook, label: string): OAuthMethod {
  const method = auth.methods.find((entry) => entry.label === label);
  if (method?.type !== "oauth") throw new Error(`missing oauth method ${label}`);
  return method;
}

async function autoCallback(method: OAuthMethod) {
  const authorization = await method.authorize();
  if (authorization.method !== "auto") throw new Error("expected an auto authorization");
  return authorization.callback();
}

const emptyProvider: Parameters<Loader>[1] = {
  id: "anthropic",
  name: "Anthropic",
  source: "api",
  env: [],
  options: {},
  models: {},
};

describe("createV1Auth methods", () => {
  it("lists cli, ccs, browser and api key methods in order", () => {
    const auth = createV1Auth(store, [{ name: "work", credentialsPath: "/missing" }]);

    expect(auth.methods.map((method) => method.label)).toEqual([
      "Claude Code (auto)",
      "CCS (work)",
      "Claude Pro/Max (browser)",
      "API Key (manual)",
    ]);
  });

  it("connects with stored claude cli credentials", async () => {
    await installClaudeStub();
    await writeCliCredentials(validTokens("cli"));

    const result = await autoCallback(oauthMethod(createV1Auth(store, []), "Claude Code (auto)"));

    expect(result).toMatchObject({ type: "success", access: "cli-access" });
  });

  it("explains how to install the cli when it is missing", async () => {
    const method = oauthMethod(createV1Auth(store, []), "Claude Code (auto)");

    const authorization = await method.authorize();

    expect(authorization.instructions).toContain("Claude CLI not found");
    expect(await autoCallback(method)).toEqual({ type: "failed" });
  });

  it("connects with ccs instance credentials", async () => {
    const instance = await writeCcsInstance("work", validTokens("work"));

    const result = await autoCallback(oauthMethod(createV1Auth(store, [instance]), "CCS (work)"));

    expect(result).toMatchObject({ type: "success", access: "work-access" });
  });

  it("exchanges a browser code", async () => {
    replaceFetch(() => tokenResponse("browser"));
    const authorization = await oauthMethod(
      createV1Auth(store, []),
      "Claude Pro/Max (browser)",
    ).authorize();
    if (authorization.method !== "code") throw new Error("expected a code authorization");

    expect(await authorization.callback("code#state")).toMatchObject({
      type: "success",
      access: "browser-access",
    });
  });

  it("reports a failed browser exchange", async () => {
    replaceFetch(() => new Response("bad code", { status: 400 }));
    const authorization = await oauthMethod(
      createV1Auth(store, []),
      "Claude Pro/Max (browser)",
    ).authorize();
    if (authorization.method !== "code") throw new Error("expected a code authorization");

    expect(await authorization.callback("wrong")).toEqual({ type: "failed" });
  });
});

describe("zeroModelCosts", () => {
  it("makes every model free for subscription usage", () => {
    const model = { cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } } };

    zeroModelCosts([model]);

    expect(model.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } });
  });
});

describe("createV1Auth loader", () => {
  it("installs the custom fetch for oauth", async () => {
    const loader = createV1Auth(store, []).loader as Loader;

    const options = await loader(
      async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }),
      emptyProvider,
    );

    expect(options.apiKey).toBe("");
    expect(options.fetch).toBeFunction();
  });

  it("keeps the default fetch for api keys", async () => {
    const loader = createV1Auth(store, []).loader as Loader;

    expect(await loader(async () => ({ type: "api", key: "k" }), emptyProvider)).toEqual({});
  });
});
