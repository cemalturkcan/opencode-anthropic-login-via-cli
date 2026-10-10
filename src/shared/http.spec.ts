import { describe, expect, it } from "bun:test";
import { replaceFetch, restoreFetchAfterEach } from "../testing/fetch.ts";
import { backoffDelayMs, fetchWithRetry } from "./http.ts";

restoreFetchAfterEach();

describe("backoffDelayMs", () => {
  it("honors retry-after up to thirty seconds", () => {
    expect(backoffDelayMs(1, "2")).toBe(2000);
    expect(backoffDelayMs(1, "600")).toBe(30_000);
  });

  it("uses full jitter exponential backoff without retry-after", () => {
    expect(backoffDelayMs(1, null, () => 0.999)).toBe(999);
    expect(backoffDelayMs(3, null, () => 0.5)).toBe(2000);
    expect(backoffDelayMs(20, null, () => 0.999)).toBe(29_970);
  });
});

describe("fetchWithRetry", () => {
  let fetchCalls: string[];

  function mockFetch(responses: Array<{ status: number; headers?: Record<string, string> }>) {
    fetchCalls = [];
    replaceFetch((input) => {
      const response = responses[fetchCalls.length] ?? responses[responses.length - 1];
      fetchCalls.push(String(input));
      return new Response("ok", {
        status: response.status,
        headers: response.headers ?? { "retry-after": "0" },
      });
    });
  }

  it("returns immediately on 200", async () => {
    mockFetch([{ status: 200 }]);

    const res = await fetchWithRetry("https://api.test/v1/messages", {}, 3);

    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBe(1);
  });

  it("retries on 429", async () => {
    mockFetch([{ status: 429 }, { status: 200 }]);

    const res = await fetchWithRetry("https://api.test/v1/messages", {}, 2);

    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBe(2);
  });

  it("retries on 529", async () => {
    mockFetch([{ status: 529 }, { status: 200 }]);

    const res = await fetchWithRetry("https://api.test/v1/messages", {}, 2);

    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBe(2);
  });

  it("does not retry on 400", async () => {
    mockFetch([{ status: 400 }]);

    const res = await fetchWithRetry("https://api.test/v1/messages", {}, 3);

    expect(res.status).toBe(400);
    expect(fetchCalls.length).toBe(1);
  });

  it("retries a transient 503", async () => {
    mockFetch([{ status: 503 }, { status: 200 }]);

    const res = await fetchWithRetry("https://api.test/v1/messages", {}, 3);

    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBe(2);
  });

  it("respects retry-after header in seconds", async () => {
    const start = Date.now();
    mockFetch([{ status: 429, headers: { "retry-after": "1" } }, { status: 200 }]);

    const res = await fetchWithRetry("https://api.test/v1/messages", {}, 2);
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it("returns last error response when all retries exhausted", async () => {
    mockFetch([{ status: 429 }, { status: 429 }, { status: 429 }]);

    const res = await fetchWithRetry("https://api.test/v1/messages", {}, 2);

    expect(res.status).toBe(429);
  });

  it("does not retry on last attempt", async () => {
    mockFetch([{ status: 429 }, { status: 429 }]);

    const res = await fetchWithRetry("https://api.test/v1/messages", {}, 1);

    expect(res.status).toBe(429);
    expect(fetchCalls.length).toBe(1);
  });
});
