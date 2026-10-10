import { afterEach, describe, expect, it } from "bun:test";
import { applyOAuthHeaders, hasJsonContentType, mergeBetas } from "./request.ts";

afterEach(() => {
  delete process.env.ANTHROPIC_BETA_FLAGS;
});

const intro = {
  version: "2.1.84",
  userAgent: "claude-cli/2.1.84 (external, cli)",
  betaHeaders: ["claude-code-20250219", "oauth-2025-04-20"],
  scopes: "user:inference",
};

describe("hasJsonContentType", () => {
  it.each(["application/json", "Application/JSON; charset=utf-8"])("accepts %s", (type) => {
    expect(hasJsonContentType(new Headers({ "content-type": type }))).toBe(true);
  });

  it("rejects other or missing content types", () => {
    expect(hasJsonContentType(new Headers({ "content-type": "text/plain" }))).toBe(false);
    expect(hasJsonContentType(new Headers())).toBe(false);
  });
});

describe("mergeBetas", () => {
  it("merges model betas with incoming betas without duplicates", () => {
    expect(mergeBetas("claude-opus-4-6", intro.betaHeaders, " oauth-2025-04-20 , custom ,")).toBe(
      "claude-code-20250219,oauth-2025-04-20,effort-2025-11-24,custom",
    );
  });

  it("uses ANTHROPIC_BETA_FLAGS instead of introspected betas", () => {
    process.env.ANTHROPIC_BETA_FLAGS = "only-this";

    expect(mergeBetas(null, intro.betaHeaders, null)).toBe("only-this");
  });
});

describe("applyOAuthHeaders", () => {
  it("replaces api-key auth with claude cli oauth headers", () => {
    const headers = new Headers({ "x-api-key": "key", "user-agent": "opencode" });

    applyOAuthHeaders(headers, "access", null, intro);

    expect(Object.fromEntries(headers)).toEqual({
      authorization: "Bearer access",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.84 (external, cli)",
      "x-app": "cli",
    });
  });
});
