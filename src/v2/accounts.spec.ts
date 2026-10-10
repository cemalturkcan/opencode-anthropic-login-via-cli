import { describe, expect, it } from "bun:test";
import { createV2Context, oauthCredential } from "../testing/v2Context.ts";
import { createAccountRouter, type AccountIntegration } from "./accounts.ts";

function setup() {
  const v2 = createV2Context(oauthCredential("claude-cli", "primary"));
  let now = 1_000;
  const integration = (v2.context as { integration: AccountIntegration }).integration;
  const router = createAccountRouter(integration, () => now);
  return { v2, router, advance: (ms: number) => (now += ms) };
}

describe("account router", () => {
  it("selects the active oauth account", async () => {
    const { router } = setup();

    expect((await router.select("session"))?.credential.access).toBe("primary");
  });

  it("returns nothing for an api-key connection", async () => {
    const v2 = createV2Context({ type: "key", key: "k" } as never);
    const router = createAccountRouter(
      (v2.context as { integration: AccountIntegration }).integration,
    );

    expect(await router.select("session")).toBeUndefined();
  });

  it("fails over to another oauth account and pins the session to it", async () => {
    const { v2, router } = setup();
    v2.addAccount("work", oauthCredential("ccs-work", "work"));
    v2.addAccount("api", { type: "key", key: "k" } as never);
    const primary = await router.select("session");

    const alternative = await router.failover("session", primary!, 5_000);

    expect(alternative?.credential.access).toBe("work");
    expect((await router.select("session"))?.credential.access).toBe("work");
    expect((await router.select("other-session"))?.credential.access).toBe("work");
  });

  it("returns a pinned session to the active account once its cooldown has passed", async () => {
    const { v2, router, advance } = setup();
    v2.addAccount("work", oauthCredential("ccs-work", "work"));
    await router.failover("session", (await router.select("session"))!, 5_000);
    advance(10_000);

    expect((await router.select("session"))?.credential.access).toBe("primary");
  });

  it("drops a pin when the user switches the active connection", async () => {
    const { v2, router } = setup();
    v2.addAccount("work", oauthCredential("ccs-work", "work"));
    v2.addAccount("personal", oauthCredential("claude-browser", "personal"));
    await router.failover("session", (await router.select("session"))!, 5_000);
    v2.activate("personal");

    expect((await router.select("session"))?.credential.access).toBe("personal");
  });

  it("drops a pin when the user switches to an api key", async () => {
    const { v2, router } = setup();
    v2.addAccount("work", oauthCredential("ccs-work", "work"));
    v2.addAccount("api", { type: "key", key: "k" } as never);
    await router.failover("session", (await router.select("session"))!, 5_000);
    v2.activate("api");

    expect(await router.select("session")).toBeUndefined();
  });

  it("stops resolving candidates at the first usable account", async () => {
    const { v2, router } = setup();
    v2.addAccount("work", oauthCredential("ccs-work", "work"));
    v2.addAccount("personal", oauthCredential("claude-browser", "personal"));
    const primary = (await router.select("session"))!;
    const before = v2.resolveCount();

    await router.failover("session", primary, 5_000);

    expect(v2.resolveCount() - before).toBe(1);
  });

  it("returns nothing when every other account is cooling down or missing", async () => {
    const { router } = setup();

    expect(
      await router.failover("session", (await router.select("session"))!, 5_000),
    ).toBeUndefined();
  });
});
