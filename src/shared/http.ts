import { log } from "./logger.ts";

const retryableStatuses = new Set([429, 529]);

export function parseRetryAfterMs(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  const seconds = Number.parseInt(retryAfter, 10);
  return Number.isNaN(seconds) ? null : seconds * 1000;
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
  const delayMs = parseRetryAfterMs(retryAfter) ?? attempt * 2000;
  log.debug("rate limited, retrying", {
    status: response.status,
    attempt,
    delayMs,
    retryAfter: retryAfter ?? "none",
  });
  await Bun.sleep(delayMs);
  return attemptFetch(url, init, attempt + 1, maxAttempts);
}

export function fetchWithRetry(url: string, init: RequestInit, maxAttempts = 3): Promise<Response> {
  return attemptFetch(url, init, 1, maxAttempts);
}
