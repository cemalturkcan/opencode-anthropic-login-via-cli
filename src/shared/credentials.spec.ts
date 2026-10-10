import { beforeEach, describe, expect, it } from "bun:test";
import { replaceFetch, restoreFetchAfterEach, tokenResponse } from "../testing/fetch.ts";
import {
  expiredTokens,
  installClaudeStub,
  resetSandbox,
  validTokens,
  writeCcsInstance,
  writeCliCredentials,
} from "../testing/fixtures.ts";
import {
  discoverCCSInstances,
  findAlternateCredentials,
  hasClaude,
  isExpiringSoon,
  parseCredentialJson,
  readClaudeCodeCredentials,
  readFreshCliCredentials,
  readKeychainCredentials,
  resolveCcsTokens,
  resolveCliTokens,
} from "./credentials.ts";

restoreFetchAfterEach();
beforeEach(resetSandbox);

describe("parseCredentialJson", () => {
  it("reads the claudeAiOauth tokens", () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 42 },
    });

    expect(parseCredentialJson(raw)).toEqual({ access: "a", refresh: "r", expires: 42 });
  });

  it("defaults a missing expiry to zero", () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } });

    expect(parseCredentialJson(raw)?.expires).toBe(0);
  });

  it("rejects credentials without a refresh token", () => {
    expect(parseCredentialJson(JSON.stringify({ claudeAiOauth: { accessToken: "a" } }))).toBeNull();
  });

  it("rejects malformed json", () => {
    expect(parseCredentialJson("{")).toBeNull();
  });
});

describe("isExpiringSoon", () => {
  it("treats tokens inside the refresh buffer as expiring", () => {
    expect(isExpiringSoon(Date.now() + 60_000)).toBe(true);
  });

  it("treats tokens valid for an hour as fresh", () => {
    expect(isExpiringSoon(Date.now() + 60 * 60 * 1000)).toBe(false);
  });
});

describe("readClaudeCodeCredentials", () => {
  it("reads the sandboxed cli credentials instead of the real home", async () => {
    await writeCliCredentials(validTokens("cli"));

    expect((await readClaudeCodeCredentials())?.access).toBe("cli-access");
  });

  it("returns null when no credentials exist", async () => {
    expect(await readClaudeCodeCredentials()).toBeNull();
  });
});

describe("readKeychainCredentials", () => {
  it("reads the claude code keychain entry through the security tool", async () => {
    await writeCliCredentials(validTokens("keychain"));

    expect(parseCredentialJson((await readKeychainCredentials()) ?? "")?.access).toBe(
      "keychain-access",
    );
  });

  it("returns null when the keychain has no entry", async () => {
    expect(await readKeychainCredentials()).toBeNull();
  });
});

describe("hasClaude", () => {
  it("finds the claude binary on the path", async () => {
    await installClaudeStub();

    expect(await hasClaude()).toBe(true);
  });

  it("reports a missing claude binary", async () => {
    expect(await hasClaude()).toBe(false);
  });
});

describe("discoverCCSInstances", () => {
  it("lists instances that have a credentials file", async () => {
    await writeCcsInstance("work", validTokens("work"));

    expect((await discoverCCSInstances()).map((instance) => instance.name)).toEqual(["work"]);
  });

  it("returns an empty list without a ccs directory", async () => {
    expect(await discoverCCSInstances()).toEqual([]);
  });
});

describe("resolveCliTokens", () => {
  it("returns fresh stored credentials without refreshing", async () => {
    await writeCliCredentials(validTokens("cli"));
    replaceFetch(() => {
      throw new Error("unexpected refresh");
    });

    expect((await resolveCliTokens())?.access).toBe("cli-access");
  });

  it("refreshes expiring stored credentials", async () => {
    await writeCliCredentials(expiredTokens("stale-cli"));
    replaceFetch(() => tokenResponse("refreshed"));

    expect((await resolveCliTokens())?.access).toBe("refreshed-access");
  });

  it("falls back to triggering the cli when the refresh fails", async () => {
    await writeCliCredentials(expiredTokens("stale-cli"));
    await installClaudeStub(validTokens("triggered"));
    replaceFetch(() => new Response("invalid_grant", { status: 400 }));

    expect((await resolveCliTokens())?.access).toBe("triggered-access");
  });

  it("returns null without stored credentials", async () => {
    expect(await resolveCliTokens()).toBeNull();
  });
});

describe("readFreshCliCredentials", () => {
  it("returns null when the cli is not installed", async () => {
    await writeCliCredentials(expiredTokens("stale-cli"));

    expect(await readFreshCliCredentials()).toBeNull();
  });

  it("returns null when the cli cannot produce fresh credentials", async () => {
    await writeCliCredentials(expiredTokens("stale-cli"));
    await installClaudeStub();

    expect(await readFreshCliCredentials()).toBeNull();
  });
});

describe("resolveCcsTokens", () => {
  it("returns fresh instance credentials", async () => {
    const instance = await writeCcsInstance("work", validTokens("work"));

    expect((await resolveCcsTokens(instance))?.access).toBe("work-access");
  });

  it("returns null when the instance refresh fails", async () => {
    const instance = await writeCcsInstance("work", expiredTokens("work"));
    replaceFetch(() => new Response("invalid_grant", { status: 400 }));

    expect(await resolveCcsTokens(instance)).toBeNull();
  });
});

describe("findAlternateCredentials", () => {
  it("prefers cli credentials that belong to another account", async () => {
    await writeCliCredentials(validTokens("cli"));

    expect((await findAlternateCredentials("current-refresh"))?.access).toBe("cli-access");
  });

  it("skips the current account and falls through to ccs instances", async () => {
    await writeCliCredentials(validTokens("current"));
    await writeCcsInstance("work", validTokens("work"));

    expect((await findAlternateCredentials("current-refresh"))?.access).toBe("work-access");
  });

  it("returns null when every source is the current or an expired account", async () => {
    await writeCliCredentials(validTokens("current"));
    await writeCcsInstance("work", expiredTokens("work"));

    expect(await findAlternateCredentials("current-refresh")).toBeNull();
  });
});
