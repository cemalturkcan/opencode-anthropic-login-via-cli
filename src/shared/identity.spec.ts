import { beforeEach, describe, expect, it } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { replaceEveryFetch, restoreFetchAfterEach } from "../testing/fetch.ts";
import { accountProfile, deviceId, resetIdentityCache } from "./identity.ts";
import { claudeConfigPath } from "./paths.ts";

restoreFetchAfterEach();
beforeEach(async () => {
  resetIdentityCache();
  await rm(claudeConfigPath(), { force: true });
});

const profileBody = {
  account: { uuid: "account-uuid", email: "dev@example.com" },
  organization: { uuid: "org-uuid" },
};

describe("deviceId", () => {
  it("reuses the claude code user id when one exists", async () => {
    await writeFile(claudeConfigPath(), JSON.stringify({ userID: "a".repeat(64) }));

    expect(await deviceId()).toBe("a".repeat(64));
  });

  it("derives a stable 64 character id without claude code", async () => {
    const first = await deviceId();
    resetIdentityCache();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await deviceId()).toBe(first);
  });
});

describe("accountProfile", () => {
  it("reads the account uuid and email from the oauth profile endpoint", async () => {
    const seen: (string | null)[] = [];
    replaceEveryFetch((input, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      expect(String(input)).toBe("https://api.anthropic.com/api/oauth/profile");
      return Response.json(profileBody);
    });

    expect(await accountProfile("access-token")).toEqual({
      uuid: "account-uuid",
      email: "dev@example.com",
    });
    expect(seen).toEqual(["Bearer access-token"]);
  });

  it("asks the profile endpoint once per access token", async () => {
    let calls = 0;
    replaceEveryFetch(() => {
      calls++;
      return Response.json(profileBody);
    });

    await Promise.all([accountProfile("same"), accountProfile("same")]);
    await accountProfile("same");

    expect(calls).toBe(1);
  });

  it("returns null when the profile cannot be read", async () => {
    replaceEveryFetch(() => new Response("unauthorized", { status: 401 }));

    expect(await accountProfile("revoked")).toBeNull();
  });

  it("asks again after a failed profile request", async () => {
    let calls = 0;
    replaceEveryFetch(() => {
      calls++;
      return calls === 1 ? new Response("busy", { status: 503 }) : Response.json(profileBody);
    });

    expect(await accountProfile("retry")).toBeNull();
    expect((await accountProfile("retry"))?.uuid).toBe("account-uuid");
  });

  it("returns null for an unexpected profile body", async () => {
    replaceEveryFetch(() => Response.json({ account: {} }));

    expect(await accountProfile("odd")).toBeNull();
  });
});
