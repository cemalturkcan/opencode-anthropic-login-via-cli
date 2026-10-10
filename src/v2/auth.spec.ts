import { beforeEach, describe, expect, it } from "bun:test";
import type { Credential } from "@opencode/plugin";
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration";
import { jsonField, replaceFetch, restoreFetchAfterEach, tokenResponse } from "../testing/fetch.ts";
import {
  expiredTokens,
  installClaudeStub,
  resetSandbox,
  validTokens,
  writeCcsInstance,
  writeCliCredentials,
} from "../testing/fixtures.ts";
import { createV2Context, oauthCredential } from "../testing/v2Context.ts";
import { setupV2Auth } from "./auth.ts";

restoreFetchAfterEach();
beforeEach(resetSandbox);

const rejectedRefresh = () => new Response("invalid_grant", { status: 400 });

async function setup(credential?: Credential.Value) {
  const v2 = createV2Context(credential);
  const instance = await writeCcsInstance("work", validTokens("work"));
  await setupV2Auth(v2.context, [instance]);
  const method = (id: string) => {
    const registration = v2.methods.get(id) as IntegrationOAuthMethodRegistration | undefined;
    if (!registration?.refresh) throw new Error(`missing oauth method ${id}`);
    return { ...registration, refresh: registration.refresh };
  };
  return { ...v2, method };
}

function staleCredential(
  methodID: string,
  metadata?: Credential.OAuth["metadata"],
): Credential.OAuth {
  return {
    ...oauthCredential(methodID, "stale-access"),
    refresh: "stale-refresh",
    expires: 0,
    metadata,
  };
}

async function autoCredential(registration: IntegrationOAuthMethodRegistration) {
  const authorization = await registration.authorize({});
  if (authorization.mode !== "auto") throw new Error("expected an auto authorization");
  return authorization.callback;
}

describe("V2 method registration", () => {
  it("registers cli, ccs, browser and migrated V1 methods and keeps the api key method", async () => {
    const v2 = await setup();

    expect([...v2.methods.keys()]).toEqual([
      "key",
      "claude-cli",
      "ccs-work",
      "claude-browser",
      "oauth",
    ]);
  });

  it("connects the cli account under its method id", async () => {
    await installClaudeStub();
    await writeCliCredentials(validTokens("cli"));
    const v2 = await setup();

    expect(await autoCredential(v2.method("claude-cli"))).toMatchObject({
      methodID: "claude-cli",
      access: "cli-access",
    });
  });

  it("stores the account email and uuid so V2 can label the connection", async () => {
    replaceFetch(rejectedRefresh);
    await installClaudeStub();
    await writeCliCredentials(validTokens("cli"));
    const v2 = await setup();
    const method = v2.method("claude-cli");

    const credential = await autoCredential(method);

    expect(credential.metadata).toEqual({
      email: "cli-access@example.com",
      accountUuid: "cli-access-uuid",
    });
    expect(method.label?.(credential)).toBe("cli-access@example.com");
  });

  it("leaves the label to OpenCode when no email is known", async () => {
    const v2 = await setup();

    expect(v2.method("claude-cli").label?.(oauthCredential())).toBeUndefined();
  });

  it("rejects the cli method when the cli is missing", async () => {
    const v2 = await setup();

    await expect(autoCredential(v2.method("claude-cli"))).rejects.toThrow("Claude CLI not found");
  });

  it("connects a ccs instance under its own method id", async () => {
    const v2 = await setup();

    expect(await autoCredential(v2.method("ccs-work"))).toMatchObject({
      methodID: "ccs-work",
      access: "work-access",
    });
  });

  it("exchanges a browser code under the browser method id", async () => {
    replaceFetch(() => tokenResponse("browser"));
    const v2 = await setup();
    const authorization = await v2.method("claude-browser").authorize({});
    if (authorization.mode !== "code") throw new Error("expected a code authorization");

    expect(await authorization.callback("code#state")).toMatchObject({
      methodID: "claude-browser",
      access: "browser-access",
    });
  });
});

describe("V2 refresh", () => {
  it("refreshes with the credential's own refresh token and keeps its metadata", async () => {
    const refreshTokens: (string | null)[] = [];
    replaceFetch((_input, init) => {
      refreshTokens.push(jsonField(init?.body, "refresh_token"));
      return tokenResponse("refreshed");
    });
    const v2 = await setup();

    const refreshed = await v2
      .method("claude-cli")
      .refresh(staleCredential("claude-cli", { email: "a@b.c" }));

    expect(refreshTokens).toEqual(["stale-refresh"]);
    expect(refreshed).toMatchObject({
      methodID: "claude-cli",
      access: "refreshed-access",
      metadata: { email: "a@b.c" },
    });
  });

  it.each(["claude-cli", "oauth"])(
    "recovers a failed %s refresh from fresh claude cli credentials",
    async (methodID) => {
      await writeCliCredentials(validTokens("cli"));
      replaceFetch(rejectedRefresh);
      const v2 = await setup();

      expect(await v2.method(methodID).refresh(staleCredential(methodID))).toMatchObject({
        methodID,
        access: "cli-access",
      });
    },
  );

  it("recovers a browser account from the cli only when it is the same account", async () => {
    await writeCliCredentials(validTokens("cli"));
    replaceFetch(rejectedRefresh);
    const v2 = await setup();
    const sameAccount = staleCredential("claude-browser", { accountUuid: "cli-access-uuid" });

    expect(await v2.method("claude-browser").refresh(sameAccount)).toMatchObject({
      access: "cli-access",
    });
  });

  it("never turns a browser account into the different cli account", async () => {
    await writeCliCredentials(validTokens("cli"));
    replaceFetch(rejectedRefresh);
    const v2 = await setup();
    const otherAccount = staleCredential("claude-browser", { accountUuid: "browser-uuid" });

    await expect(v2.method("claude-browser").refresh(otherAccount)).rejects.toThrow(
      "Token refresh failed: 400",
    );
  });

  it("never recovers a browser account without a known account", async () => {
    await writeCliCredentials(validTokens("cli"));
    replaceFetch(rejectedRefresh);
    const v2 = await setup();

    await expect(
      v2.method("claude-browser").refresh(staleCredential("claude-browser")),
    ).rejects.toThrow("Token refresh failed: 400");
  });

  it("rejects a failed browser refresh when the cli credentials are expired too", async () => {
    await installClaudeStub();
    await writeCliCredentials(expiredTokens("cli"));
    replaceFetch(rejectedRefresh);
    const v2 = await setup();

    await expect(
      v2.method("claude-browser").refresh(staleCredential("claude-browser")),
    ).rejects.toThrow("Token refresh failed: 400");
  });

  it("never swaps a ccs account for the cli account", async () => {
    await writeCliCredentials(validTokens("cli"));
    replaceFetch(rejectedRefresh);
    const v2 = await setup();

    await expect(v2.method("ccs-work").refresh(staleCredential("ccs-work"))).rejects.toThrow(
      "Token refresh failed: 400",
    );
  });
});

describe("V2 subscription pricing", () => {
  it("zeroes anthropic pricing when an oauth account is active at startup", async () => {
    const v2 = await setup(oauthCredential());

    expect(v2.model.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }]);
  });

  it("keeps pricing for api-key connections", async () => {
    const v2 = await setup({ type: "key", key: "k" } as never);

    expect(v2.model.cost[0].input).toBe(3);
    expect(v2.reloadCount()).toBe(0);
  });

  it("zeroes pricing after a new oauth login", async () => {
    await writeCliCredentials(validTokens("cli"));
    await installClaudeStub();
    const v2 = await setup();

    await autoCredential(v2.method("claude-cli"));

    expect(v2.model.cost[0].input).toBe(0);
  });
});
