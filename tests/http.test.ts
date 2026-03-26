import { describe, expect, it, afterEach } from "bun:test";
import { fetchWithRetry } from "../src/http.ts";

describe("fetchWithRetry", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; init: RequestInit }[];

  function mockFetch(responses: Array<{ status: number; headers?: Record<string, string> }>) {
    let callIndex = 0;
    fetchCalls = [];

    globalThis.fetch = (async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), init });
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return new Response("ok", {
        status: resp.status,
        headers: resp.headers ?? {},
      });
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

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

  it("does not retry on 500", async () => {
    mockFetch([{ status: 500 }]);

    const res = await fetchWithRetry("https://api.test/v1/messages", {}, 3);

    expect(res.status).toBe(500);
    expect(fetchCalls.length).toBe(1);
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
