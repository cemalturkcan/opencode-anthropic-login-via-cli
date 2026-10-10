import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/index.ts";
import { readClaudeCodeCredentials, resetRefreshState } from "../src/credentials.ts";
import { createV1Auth } from "../src/v1-auth.ts";
import { setupV2Auth } from "../src/v2-auth.ts";

const originalEnv = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  USER: process.env.USER,
};
const originalFetch = globalThis.fetch;
let testHome: string;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (testHome) await rm(testHome, { recursive: true, force: true });
  resetRefreshState();
});

async function useIsolatedCredentials() {
  testHome = await mkdtemp(join(tmpdir(), "anthropic-auth-adapters-"));
  const bin = join(testHome, "bin");
  const ccsPath = join(testHome, ".ccs", "instances", "work", ".credentials.json");
  await mkdir(bin, { recursive: true });
  await mkdir(join(testHome, ".ccs", "instances", "work"), { recursive: true });
  await writeFile(
    join(testHome, "cli-credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "fixture-cli-access",
        refreshToken: "fixture-cli-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    }),
  );
  await writeFile(
    ccsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "fixture-ccs-access",
        refreshToken: "fixture-ccs-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    }),
  );
  const security = join(bin, "security");
  await writeFile(security, '#!/bin/sh\n/bin/cat "$HOME/cli-credentials.json"\n');
  await chmod(security, 0o755);
  const claude = join(bin, "claude");
  await writeFile(claude, "#!/bin/sh\nexit 0\n");
  await chmod(claude, 0o755);
  const which = join(bin, "which");
  await writeFile(
    which,
    '#!/bin/sh\n[ "$1" = claude ] && { echo "$HOME/bin/claude"; exit 0; }\nexit 1\n',
  );
  await chmod(which, 0o755);
  process.env.HOME = testHome;
  process.env.USER = "fixture-user";
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  return { ccsPath };
}

function makeV2Context(connection: unknown, credential: unknown) {
  const methods = new Map<string, any>([["key", { type: "key", label: "API Key" }]]);
  const model = {
    id: "fixture-model",
    providerID: "anthropic",
    cost: [{ input: 1, output: 2, cache: { read: 3, write: 4 } }],
  };
  let transform: ((editor: any) => void) | undefined;
  const applyTransform = () =>
    transform?.({
      list: () => [model],
      update: (_providerID: string, _modelID: string, update: (draft: typeof model) => void) =>
        update(model),
    });
  const context = {
    session: { hook: async () => ({ dispose: async () => {} }) },
    model: {
      transform: async (callback: (editor: any) => void) => {
        transform = callback;
      },
      reload: async () => applyTransform(),
    },
    integration: {
      transform: async (callback: (editor: any) => void) =>
        callback({
          method: {
            list: () => [...methods.values()].map((entry) => entry.method ?? entry),
            update: (registration: any) =>
              methods.set(
                registration.method.type === "key" ? "key" : registration.method.id,
                registration,
              ),
            remove: () => {},
          },
        }),
      reload: async () => {},
      connection: {
        active: async () => connection,
        resolve: async () => credential,
      },
    },
  };
  return { context, methods, model, applyTransform };
}

describe("V1 and V2 auth adapters", () => {
  it("keeps CLI, CCS, browser, API-key, and subscription pricing behavior", async () => {
    const { ccsPath } = await useIsolatedCredentials();
    expect(plugin.id).toBe("opencode-anthropic-login-via-cli");
    expect(typeof plugin.server).toBe("function");
    expect(typeof plugin.setup).toBe("function");
    expect(await readClaudeCodeCredentials()).toBeTruthy();
    let v1CredentialUpdates = 0;
    const v1Auth = createV1Auth({ auth: { set: async () => v1CredentialUpdates++ } } as never, [
      { name: "work", credentialsPath: ccsPath },
    ]);
    const v1Cli = v1Auth.methods.find(
      (method: any) => method.label === "Claude Code (auto)",
    ) as any;
    const v1Ccs = v1Auth.methods.find((method: any) => method.label === "CCS (work)") as any;
    const v1Browser = v1Auth.methods.find(
      (method: any) => method.label === "Claude Pro/Max (browser)",
    ) as any;
    const v1ApiKey = v1Auth.methods.find((method: any) => method.type === "api");

    expect((await (await v1Cli.authorize()).callback()).access).toBe("fixture-cli-access");
    expect((await (await v1Ccs.authorize()).callback()).access).toBe("fixture-ccs-access");
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: "fixture-browser-access",
          refresh_token: "fixture-browser-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      )) as typeof fetch;
    const v1BrowserFlow = await v1Browser.authorize();
    expect(v1BrowserFlow.method).toBe("code");
    expect((await v1BrowserFlow.callback("fixture-code")).access).toBe("fixture-browser-access");
    expect(v1ApiKey).toBeDefined();

    const v1Provider = {
      models: { model: { cost: { input: 1, output: 2, cache: { read: 3, write: 4 } } } },
    };
    await v1Auth.loader!(
      async () => ({ type: "oauth", access: "fixture", refresh: "fixture", expires: 0 }),
      v1Provider as never,
    );
    expect(v1Provider.models.model.cost.input).toBe(0);
    const v1KeyProvider = {
      models: { model: { cost: { input: 1, output: 2, cache: { read: 3, write: 4 } } } },
    };
    expect(
      await v1Auth.loader!(
        async () => ({ type: "api", key: "fixture-api-key" }),
        v1KeyProvider as never,
      ),
    ).toEqual({});
    expect(v1KeyProvider.models.model.cost.input).toBe(1);

    let v1FetchCalls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      v1FetchCalls++;
      if (v1FetchCalls === 1) return new Response("unauthorized", { status: 401 });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-cli-access");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const v1OAuth = await v1Auth.loader!(
      async () => ({
        type: "oauth",
        access: "fixture-expired-access",
        refresh: "old-refresh",
        expires: Date.now() + 60 * 60 * 1000,
      }),
      v1Provider as never,
    );
    const v1Response = await v1OAuth.fetch!("https://api.anthropic.com/v1/models");
    expect(await v1Response.text()).toBe("ok");
    expect(v1FetchCalls).toBe(2);
    expect(v1CredentialUpdates).toBe(1);

    globalThis.fetch = (async () => new Response("expired", { status: 400 })) as typeof fetch;
    const v2 = makeV2Context(
      { type: "credential", id: "oauth", method: "oauth" },
      {
        type: "oauth",
        methodID: "claude-cli",
        access: "fixture-expired-access",
        refresh: "old-refresh",
        expires: 0,
      },
    );
    await setupV2Auth(v2.context as never, [{ name: "work", credentialsPath: ccsPath }], () => {});

    const v2Cli = v2.methods.get("claude-cli");
    const v2Ccs = v2.methods.get("ccs-work");
    const v2Browser = v2.methods.get("claude-browser");
    expect(
      [...v2.methods.values()]
        .filter((method) => method.method)
        .every((method) => method.method.type === "oauth"),
    ).toBe(true);
    expect(v2.methods.get("key")).toEqual({ type: "key", label: "API Key" });
    expect((await (await v2Cli.authorize({})).callback).access).toBe("fixture-cli-access");
    expect((await (await v2Ccs.authorize({})).callback).access).toBe("fixture-ccs-access");
    const v2BrowserFlow = await v2Browser.authorize({});
    expect(v2BrowserFlow.mode).toBe("code");
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: "fixture-browser-access",
          refresh_token: "fixture-browser-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      )) as typeof fetch;
    expect((await v2BrowserFlow.callback("fixture-code")).access).toBe("fixture-browser-access");
    let refreshBody = "";
    globalThis.fetch = (async (_input, init) => {
      refreshBody = String(init?.body);
      return new Response(
        JSON.stringify({
          access_token: "fixture-refreshed-access",
          refresh_token: "fixture-refreshed-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const refreshed = await v2Cli.refresh({
      type: "oauth",
      methodID: "claude-cli",
      access: "fixture-expired-access",
      refresh: "same-method-refresh",
      expires: 0,
    });
    expect(refreshBody).toContain("refresh_token=same-method-refresh");
    expect(refreshed).toMatchObject({
      type: "oauth",
      methodID: "claude-cli",
      access: "fixture-refreshed-access",
      refresh: "fixture-refreshed-refresh",
    });

    globalThis.fetch = (async () => new Response("expired", { status: 400 })) as typeof fetch;
    expect(
      await v2Cli.refresh({
        type: "oauth",
        methodID: "claude-cli",
        access: "fixture-expired-access",
        refresh: "invalid-refresh",
        expires: 0,
      }),
    ).toMatchObject({ methodID: "claude-cli", access: "fixture-cli-access" });
    await expect(
      v2Ccs.refresh({
        type: "oauth",
        methodID: "ccs-work",
        access: "fixture-expired-access",
        refresh: "invalid-ccs-refresh",
        expires: 0,
      }),
    ).rejects.toThrow("Token refresh failed: 400");
    expect(v2.model.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }]);
  });

  it("leaves V2 model pricing unchanged for API-key connections", async () => {
    await useIsolatedCredentials();
    const v2 = makeV2Context(
      { type: "credential", id: "key", method: "key" },
      {
        type: "key",
        key: "fixture-api-key",
      },
    );
    await setupV2Auth(v2.context as never, [], () => {});
    v2.applyTransform();
    expect(v2.model.cost).toEqual([{ input: 1, output: 2, cache: { read: 3, write: 4 } }]);
    expect(v2.methods.get("key")).toEqual({ type: "key", label: "API Key" });
    const connection = await v2.context.integration.connection.active("anthropic");
    expect(await v2.context.integration.connection.resolve(connection)).toEqual({
      type: "key",
      key: "fixture-api-key",
    });
  });

  it("recovers an expired V2 browser credential from valid CLI credentials", async () => {
    await useIsolatedCredentials();
    const v2 = makeV2Context(undefined, undefined);
    await setupV2Auth(v2.context as never, [], () => {});
    globalThis.fetch = (async () =>
      new Response("invalid refresh token", { status: 400 })) as typeof fetch;

    const credential = await v2.methods.get("claude-browser").refresh({
      type: "oauth",
      methodID: "claude-browser",
      access: "expired-browser-access",
      refresh: "invalid-browser-refresh",
      expires: 0,
    });

    expect(credential).toMatchObject({
      type: "oauth",
      methodID: "claude-browser",
      access: "fixture-cli-access",
      refresh: "fixture-cli-refresh",
    });
    expect(credential.expires).toBeGreaterThan(Date.now());
  });

  it("rejects V2 browser refresh when CLI credentials remain expired", async () => {
    await useIsolatedCredentials();
    await writeFile(
      join(testHome, "cli-credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-cli-access",
          refreshToken: "expired-cli-refresh",
          expiresAt: 0,
        },
      }),
    );
    const v2 = makeV2Context(undefined, undefined);
    await setupV2Auth(v2.context as never, [], () => {});
    globalThis.fetch = (async () =>
      new Response("invalid refresh token", { status: 400 })) as typeof fetch;

    await expect(
      v2.methods.get("claude-browser").refresh({
        type: "oauth",
        methodID: "claude-browser",
        access: "expired-browser-access",
        refresh: "invalid-browser-refresh",
        expires: 0,
      }),
    ).rejects.toThrow("Token refresh failed: 400");
  });

  it("refreshes migrated V1 OAuth credentials through the legacy method ID", async () => {
    await useIsolatedCredentials();
    const v2 = makeV2Context(
      { type: "credential", id: "legacy", method: "oauth" },
      {
        type: "oauth",
        methodID: "oauth",
        access: "expired-access",
        refresh: "old-refresh",
        expires: 0,
      },
    );
    await setupV2Auth(v2.context as never, [], () => {});
    const legacy = v2.methods.get("oauth");
    expect(legacy).toBeDefined();
    globalThis.fetch = (async () =>
      new Response("invalid refresh token", { status: 400 })) as typeof fetch;

    expect(
      await legacy.refresh({
        type: "oauth",
        methodID: "oauth",
        access: "expired-access",
        refresh: "old-refresh",
        expires: 0,
      }),
    ).toMatchObject({
      methodID: "oauth",
      access: "fixture-cli-access",
      refresh: "fixture-cli-refresh",
    });
  });
});
