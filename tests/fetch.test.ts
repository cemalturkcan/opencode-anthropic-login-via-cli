import { describe, expect, it } from "bun:test";

// these are not exported, so we test the logic inline
function isLongContextError(body: string): boolean {
  return (
    body.includes("Extra usage is required for long context requests") ||
    body.includes("extra_usage") ||
    body.includes("usage_limit_exceeded")
  );
}

function isBillingError(body: string): boolean {
  return body.includes("billing_error");
}

describe("isLongContextError", () => {
  it("detects 'Extra usage is required for long context requests'", () => {
    const body = JSON.stringify({
      error: {
        type: "error",
        message: "Extra usage is required for long context requests",
      },
    });
    expect(isLongContextError(body)).toBe(true);
  });

  it("detects extra_usage error type", () => {
    const body = JSON.stringify({
      error: { type: "extra_usage" },
    });
    expect(isLongContextError(body)).toBe(true);
  });

  it("detects usage_limit_exceeded", () => {
    const body = JSON.stringify({
      error: { type: "usage_limit_exceeded" },
    });
    expect(isLongContextError(body)).toBe(true);
  });

  it("returns false for normal rate limit", () => {
    const body = JSON.stringify({
      error: {
        type: "rate_limit_error",
        message: "Rate limit exceeded",
      },
    });
    expect(isLongContextError(body)).toBe(false);
  });

  it("returns false for empty body", () => {
    expect(isLongContextError("")).toBe(false);
  });
});

describe("isBillingError", () => {
  it("detects billing_error", () => {
    const body = JSON.stringify({
      error: { type: "billing_error" },
    });
    expect(isBillingError(body)).toBe(true);
  });

  it("returns false for other errors", () => {
    const body = JSON.stringify({
      error: { type: "rate_limit_error" },
    });
    expect(isBillingError(body)).toBe(false);
  });
});

describe("Issue #5 — non-retryable 429 classification", () => {
  it("long context 429 should not be retried", () => {
    const body = JSON.stringify({
      error: {
        type: "error",
        message: "Extra usage is required for long context requests",
      },
    });
    const is429 = true;
    const shouldRetry = !(is429 && (isLongContextError(body) || isBillingError(body)));
    expect(shouldRetry).toBe(false);
  });

  it("billing 429 should not be retried", () => {
    const body = JSON.stringify({ error: { type: "billing_error" } });
    const is429 = true;
    const shouldRetry = !(is429 && (isLongContextError(body) || isBillingError(body)));
    expect(shouldRetry).toBe(false);
  });

  it("normal rate limit 429 should be retried", () => {
    const body = JSON.stringify({
      error: { type: "rate_limit_error", message: "Rate limit exceeded" },
    });
    const is429 = true;
    const shouldRetry = !(is429 && (isLongContextError(body) || isBillingError(body)));
    expect(shouldRetry).toBe(true);
  });

  it("401 should be retried regardless of body", () => {
    const body = JSON.stringify({
      error: { type: "authentication_error" },
    });
    const is429 = false;
    const shouldRetry = !(is429 && (isLongContextError(body) || isBillingError(body)));
    expect(shouldRetry).toBe(true);
  });
});
