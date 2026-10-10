import { afterEach } from "bun:test";
import { isJsonObject, isJsonString, parseJson } from "../shared/json.ts";

type FetchHandler = (
  input: RequestInfo | URL,
  init?: BunFetchRequestInit,
) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;

const profileUrl = "https://api.anthropic.com/api/oauth/profile";

export function profileFor(access: string): Response {
  return Response.json({ account: { uuid: `${access}-uuid`, email: `${access}@example.com` } });
}

function isProfileRequest(input: RequestInfo | URL): boolean {
  return (input instanceof Request ? input.url : input.toString()) === profileUrl;
}

export function replaceEveryFetch(handler: FetchHandler): void {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: BunFetchRequestInit) => handler(input, init),
    { preconnect: originalFetch.preconnect },
  );
}

export function replaceFetch(handler: FetchHandler): void {
  replaceEveryFetch((input, init) => {
    if (!isProfileRequest(input)) return handler(input, init);
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    return profileFor(authorization.replace("Bearer ", ""));
  });
}

export function restoreFetchAfterEach(): void {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
}

export function jsonField(body: BodyInit | null | undefined, field: string): string | null {
  const parsed = parseJson(String(body));
  if (!isJsonObject(parsed)) return null;
  const value = parsed[field];
  return isJsonString(value) ? value : null;
}

export function tokenResponse(prefix: string): Response {
  return Response.json({
    access_token: `${prefix}-access`,
    refresh_token: `${prefix}-refresh`,
    expires_in: 3600,
  });
}
