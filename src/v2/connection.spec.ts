import { describe, expect, it } from "bun:test";
import { oauthCredential } from "../testing/v2Context.ts";
import { resolveOAuthCredential, type IntegrationAccess } from "./connection.ts";

function integration(resolve: IntegrationAccess["connection"]["resolve"]): IntegrationAccess {
  return {
    connection: {
      active: async () => ({ type: "env", name: "ANTHROPIC_API_KEY" }),
      resolve,
      status: async () => {},
    },
  };
}

describe("resolveOAuthCredential", () => {
  it("returns the active oauth credential", async () => {
    const credential = oauthCredential();

    expect(await resolveOAuthCredential(integration(async () => credential))).toBe(credential);
  });

  it("ignores api-key credentials", async () => {
    expect(
      await resolveOAuthCredential(integration(async () => ({ type: "key", key: "k" }))),
    ).toBeUndefined();
  });

  it("treats a failing connection lookup as no oauth credential", async () => {
    const failing = integration(async () => {
      throw new Error("store unavailable");
    });

    expect(await resolveOAuthCredential(failing)).toBeUndefined();
  });
});
