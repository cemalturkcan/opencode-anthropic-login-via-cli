import { afterEach } from "bun:test";

type FetchHandler = (
  input: RequestInfo | URL,
  init?: BunFetchRequestInit,
) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;

export function replaceFetch(handler: FetchHandler): void {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: BunFetchRequestInit) => handler(input, init),
    { preconnect: originalFetch.preconnect },
  );
}

export function restoreFetchAfterEach(): void {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
}

export function tokenResponse(prefix: string): Response {
  return Response.json({
    access_token: `${prefix}-access`,
    refresh_token: `${prefix}-refresh`,
    expires_in: 3600,
  });
}
