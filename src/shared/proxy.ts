import { log } from "./logger.ts";

type ResolvedBaseUrl = { raw: string | undefined; url: URL | null };

let resolved: ResolvedBaseUrl | null = null;

function parseBaseUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    log.warn("ANTHROPIC_BASE_URL is not a valid url, ignoring", { raw });
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    log.warn("ANTHROPIC_BASE_URL has an unsupported protocol, ignoring", {
      protocol: url.protocol,
    });
    return null;
  }
  if (url.username || url.password) {
    log.warn("ANTHROPIC_BASE_URL contains credentials, ignoring");
    return null;
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    log.warn("ANTHROPIC_BASE_URL must be an origin without a path, ignoring", {
      hint: url.origin,
    });
    return null;
  }

  log.info("proxy configured", { baseUrl: url.origin });
  return url;
}

export function resolveBaseUrl(): URL | null {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  if (resolved && resolved.raw === raw) return resolved.url;

  resolved = { raw, url: raw ? parseBaseUrl(raw) : null };
  return resolved.url;
}

export function isInsecure(): boolean {
  if (!resolveBaseUrl()) return false;
  const setting = process.env.ANTHROPIC_INSECURE?.trim();
  return setting === "1" || setting === "true";
}

export function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    return new URL(input instanceof Request ? input.url : input.toString());
  } catch {
    return null;
  }
}

function withUrl<T extends RequestInfo | URL>(input: T, url: URL): T | URL | Request {
  return input instanceof Request ? new Request(url.toString(), input) : url;
}

export function rewriteOrigin(input: Request): Request;
export function rewriteOrigin(input: RequestInfo | URL): RequestInfo | URL;
export function rewriteOrigin(input: RequestInfo | URL): RequestInfo | URL {
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) return input;

  const url = requestUrl(input);
  if (!url) return input;

  const rewritten = new URL(url);
  rewritten.protocol = baseUrl.protocol;
  rewritten.host = baseUrl.host;
  if (rewritten.href === url.href) return input;

  log.debug("rewrote request origin", { from: url.host, to: baseUrl.host });
  return withUrl(input, rewritten);
}

export function addBetaParam(input: Request): Request;
export function addBetaParam(input: RequestInfo | URL): RequestInfo | URL;
export function addBetaParam(input: RequestInfo | URL): RequestInfo | URL {
  const url = requestUrl(input);
  if (url?.pathname !== "/v1/messages" || url.searchParams.has("beta")) return input;

  url.searchParams.set("beta", "true");
  return withUrl(input, url);
}
