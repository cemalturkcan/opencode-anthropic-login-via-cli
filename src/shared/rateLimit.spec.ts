import { describe, expect, it } from "bun:test";
import { isTerminalRateLimit, isVersionTooOld, rateLimitResetAt } from "./rateLimit.ts";

describe("isTerminalRateLimit", () => {
  it.each([
    "Extra usage is required for long context requests",
    '{"error":{"type":"extra_usage"}}',
    '{"error":{"type":"usage_limit_exceeded"}}',
    '{"error":{"type":"billing_error"}}',
  ])("treats a 429 with %s as terminal", (body) => {
    expect(isTerminalRateLimit(429, body)).toBe(true);
  });

  it("treats an ordinary rate limit as recoverable", () => {
    expect(isTerminalRateLimit(429, '{"error":{"type":"rate_limit_error"}}')).toBe(false);
  });

  it("only classifies 429 responses", () => {
    expect(isTerminalRateLimit(401, '{"error":{"type":"billing_error"}}')).toBe(false);
  });
});

describe("isVersionTooOld", () => {
  it("detects the claude code version gate", () => {
    expect(isVersionTooOld(400, '{"error":{"type":"claude_code_version_too_old"}}')).toBe(true);
    expect(isVersionTooOld(400, '{"error":{"type":"invalid_request_error"}}')).toBe(false);
  });
});

describe("rateLimitResetAt", () => {
  const now = 1_000_000;

  it("uses the unified reset header in epoch seconds", () => {
    const headers = new Headers({ "anthropic-ratelimit-unified-reset": "2000" });

    expect(rateLimitResetAt(headers, now)).toBe(2_000_000);
  });

  it("uses retry-after seconds", () => {
    expect(rateLimitResetAt(new Headers({ "retry-after": "30" }), now)).toBe(now + 30_000);
  });

  it("uses a retry-after http date", () => {
    const date = new Date(now + 90_000).toUTCString();

    expect(rateLimitResetAt(new Headers({ "retry-after": date }), now)).toBe(Date.parse(date));
  });

  it("falls back to one minute", () => {
    expect(rateLimitResetAt(new Headers(), now)).toBe(now + 60_000);
  });
});
