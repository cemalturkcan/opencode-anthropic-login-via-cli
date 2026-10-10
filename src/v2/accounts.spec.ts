import { describe, expect, it } from "bun:test";
import { createV2Context, oauthCredential } from "../testing/v2Context.ts";
import { createAccountRouter, type AccountIntegration } from "./accounts.ts";

function setup() {
  const v2 = createV2Context(oauthCredential("claude-cli", "primary"));
  let now = 1_000;
  const integration = (v2.context as { integration: AccountIntegration }).integration;
  const router = createAccountRouter(integration, () => now);
  return { v2, integration, router, advance: (ms: number) => (now += ms) };
}

describe("account router", () => {
  it("selects the active oauth account", async () => {
    const { router } = setup();

    expect((await router.select())?.credential.access).toBe("primary");
  });

  it("returns nothing for an api-key connection", async () => {
    const v2 = createV2Context({ type: "key", key: "k" } as never);
    const router = createAccountRouter(
      (v2.context as { integration: AccountIntegration }).integration,
    );

    expect(await router.select()).toBeUndefined();
  });

  it("fails over to another oauth account and uses it while the active one cools down", async () => {
    const { v2, router } = setup();
    v2.addAccount("api", { type: "key", key: "k" } as never);
    v2.addAccount("work", oauthCredential("ccs-work", "work"));
    const primary = await router.select();

    const alternative = await router.failover(primary!, 5_000);

    expect(alternative?.credential.access).toBe("work");
    expect((await router.select())?.credential.access).toBe("work");
  });

  it("never fails over to the account that was rate limited", async () => {
    const { router } = setup();

    expect(await router.failover((await router.select())!, 5_000)).toBeUndefined();
  });

  it("returns to the active account once its cooldown has passed", async () => {
    const { v2, router, advance } = setup();
    v2.addAccount("work", oauthCredential("ccs-work", "work"));
    await router.failover((await router.select())!, 5_000);
    advance(10_000);

    expect((await router.select())?.credential.access).toBe("primary");
  });

  it("follows the user when the active connection changes during a cooldown", async () => {
    const { v2, router } = setup();
    v2.addAccount("work", oauthCredential("ccs-work", "work"));
    v2.addAccount("personal", oauthCredential("claude-browser", "personal"));
    await router.failover((await router.select())!, 5_000);
    v2.activate("personal");

    expect((await router.select())?.credential.access).toBe("personal");
  });

  it("skips accounts that are cooling down themselves", async () => {
    const { v2, router } = setup();
    v2.addAccount("work", oauthCredential("ccs-work", "work"));
    v2.addAccount("personal", oauthCredential("claude-browser", "personal"));
    const work = await router.failover((await router.select())!, 5_000);

    expect((await router.failover(work!, 5_000))?.credential.access).toBe("personal");
  });

  it("falls back to the cooling active account when no other account is usable", async () => {
    const { router } = setup();
    await router.failover((await router.select())!, 5_000);

    expect((await router.select())?.credential.access).toBe("primary");
  });

  it("stops resolving candidates at the first usable account", async () => {
    const { v2, router } = setup();
    v2.addAccount("work", oauthCredential("ccs-work", "work"));
    v2.addAccount("personal", oauthCredential("claude-browser", "personal"));
    const primary = (await router.select())!;
    const before = v2.resolveCount();

    await router.failover(primary, 5_000);

    expect(v2.resolveCount() - before).toBe(1);
  });

  it("treats a failing connection lookup as no account", async () => {
    const { integration } = setup();
    const failing: AccountIntegration = {
      ...integration,
      connection: {
        ...integration.connection,
        resolve: async () => {
          throw new Error("store unavailable");
        },
      },
    };

    expect(await createAccountRouter(failing).select()).toBeUndefined();
  });
});
