const terminalRateLimitMarkers = [
  "Extra usage is required for long context requests",
  "extra_usage",
  "usage_limit_exceeded",
  "billing_error",
];
const fallbackCooldownMs = 60_000;

export function isTerminalRateLimit(status: number, body: string): boolean {
  return status === 429 && terminalRateLimitMarkers.some((marker) => body.includes(marker));
}

export function isVersionTooOld(status: number, body: string): boolean {
  return status === 400 && body.includes("claude_code_version_too_old");
}

export function parseRetryAfterMs(retryAfter: string | null, now = Date.now()): number | null {
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (retryAfter.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export function rateLimitResetAt(headers: Headers, now = Date.now()): number {
  const unified = Number(headers.get("anthropic-ratelimit-unified-reset"));
  if (Number.isFinite(unified) && unified > 0) return unified * 1000;
  return now + (parseRetryAfterMs(headers.get("retry-after"), now) ?? fallbackCooldownMs);
}
