import { afterEach, describe, expect, it } from "bun:test";
import { claudeCodeBetas } from "./modelConfig.ts";
import { applyOAuthHeaders, hasJsonContentType, mergeBetas } from "./request.ts";

afterEach(() => {
  delete process.env.ANTHROPIC_BETA_FLAGS;
  delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT;
});

const identity = {
  access: "access",
  sessionId: "session-uuid",
  cli: { version: "2.1.296", userAgent: "claude-cli/2.1.296 (external, sdk-cli)" },
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
  it("appends incoming betas after the claude code betas without duplicates", () => {
    expect(mergeBetas("claude-sonnet-5-5", " oauth-2025-04-20 , custom ,")).toBe(
      [...claudeCodeBetas, "custom"].join(","),
    );
  });

  it("adds the long-context beta for opted-in 4.x models", () => {
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "1";

    expect(mergeBetas("claude-sonnet-4-6", null)).toContain("context-1m-2025-08-07");
  });

  it("uses ANTHROPIC_BETA_FLAGS instead of the claude code betas", () => {
    process.env.ANTHROPIC_BETA_FLAGS = "only-this";

    expect(mergeBetas(null, null)).toBe("only-this");
  });
});

describe("applyOAuthHeaders", () => {
  it("sends the header set captured from claude code 2.1.296", () => {
    const headers = new Headers({ "x-api-key": "key", "user-agent": "opencode" });

    applyOAuthHeaders(headers, null, identity);

    expect(Object.fromEntries(headers)).toMatchObject({
      authorization: "Bearer access",
      "anthropic-beta": claudeCodeBetas.join(","),
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/2.1.296 (external, sdk-cli)",
      "x-app": "cli",
      "x-claude-code-session-id": "session-uuid",
      "x-stainless-lang": "js",
      "x-stainless-package-version": "0.128.0",
      "x-stainless-retry-count": "0",
      "x-stainless-runtime": "node",
      "x-stainless-timeout": "600",
    });
    expect(headers.has("x-api-key")).toBe(false);
  });

  it("keeps an anthropic-version chosen by the caller", () => {
    const headers = new Headers({ "anthropic-version": "2024-01-01" });

    applyOAuthHeaders(headers, null, identity);

    expect(headers.get("anthropic-version")).toBe("2024-01-01");
  });
});
