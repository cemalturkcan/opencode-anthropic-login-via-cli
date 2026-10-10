import { log } from "./logger.ts";
import { parseRetryAfterMs } from "./rateLimit.ts";

const retryableStatuses = new Set([429, 500, 502, 503, 504, 529]);
const backoffBaseMs = 500;
const maxDelayMs = 30_000;

export function backoffDelayMs(
  attempt: number,
  retryAfter: string | null,
  random = Math.random,
): number {
  const requested = parseRetryAfterMs(retryAfter);
  if (requested !== null) return Math.min(requested, maxDelayMs);
  return Math.floor(random() * Math.min(maxDelayMs, backoffBaseMs * 2 ** attempt));
}

async function attemptFetch(
  url: string,
  init: RequestInit,
  attempt: number,
  maxAttempts: number,
): Promise<Response> {
  const response = await fetch(url, init);
  if (!retryableStatuses.has(response.status) || attempt >= maxAttempts) return response;

  const retryAfter = response.headers.get("retry-after");
  const delayMs = backoffDelayMs(attempt, retryAfter);
  log.debug("token endpoint busy, retrying", { status: response.status, attempt, delayMs });
  await Bun.sleep(delayMs);
  return attemptFetch(url, init, attempt + 1, maxAttempts);
}

export function fetchWithRetry(url: string, init: RequestInit, maxAttempts = 3): Promise<Response> {
  return attemptFetch(url, init, 1, maxAttempts);
}
