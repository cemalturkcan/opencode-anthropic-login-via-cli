import { log } from "./logger.ts";

let _resolved: URL | null | undefined;
let _logged = false;

/**
 * Parse ANTHROPIC_BASE_URL from the environment.
 * Returns a valid HTTP(S) URL or null if unset/invalid.
 *
 * Rejects URLs with embedded credentials or non-empty paths for safety.
 * Result is cached for the process lifetime.
 */
export function resolveBaseUrl(): URL | null {
  if (_resolved !== undefined) return _resolved;

  const raw = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!raw) {
    _resolved = null;
    return null;
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      log.warn("ANTHROPIC_BASE_URL has unsupported protocol, ignoring", {
        protocol: url.protocol,
      });
      _resolved = null;
      return null;
    }
    if (url.username || url.password) {
      log.warn("ANTHROPIC_BASE_URL contains credentials, ignoring for safety");
      _resolved = null;
      return null;
    }
    if (url.pathname !== "/" && url.pathname !== "") {
      log.warn("ANTHROPIC_BASE_URL contains a path which would be ignored — use origin only", {
        url: raw,
        hint: `Try ${url.origin} instead`,
      });
      _resolved = null;
      return null;
    }
    _resolved = url;

    if (!_logged) {
      log.info("Proxy configured", {
        baseUrl: url.origin,
        insecure: isInsecure(),
      });
      _logged = true;
    }

    return url;
  } catch {
    log.warn("ANTHROPIC_BASE_URL is not a valid URL, ignoring", { raw });
    _resolved = null;
    return null;
  }
}

/**
 * Reset cached state. Only needed for tests.
 */
export function resetProxyCache(): void {
  _resolved = undefined;
  _logged = false;
}

/**
 * Check if TLS verification should be skipped for custom API endpoints.
 * Only effective when ANTHROPIC_BASE_URL is also set — prevents accidental
 * use against the production Anthropic API.
 */
export function isInsecure(): boolean {
  if (!resolveBaseUrl()) return false;
  const raw = process.env.ANTHROPIC_INSECURE?.trim();
  return raw === "1" || raw === "true";
}

/**
 * Rewrite the origin (protocol + host) of a request URL when
 * ANTHROPIC_BASE_URL is configured. Preserves the original path
 * and query parameters.
 *
 * Returns the input unchanged when no base URL is set.
 */
export function rewriteOrigin(input: RequestInfo | URL): RequestInfo | URL {
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) return input;

  try {
    let reqUrl: URL;
    if (typeof input === "string") {
      reqUrl = new URL(input);
    } else if (input instanceof URL) {
      reqUrl = new URL(input.toString());
    } else if (input instanceof Request) {
      reqUrl = new URL(input.url);
    } else {
      return input;
    }

    const original = reqUrl.href;
    reqUrl.protocol = baseUrl.protocol;
    reqUrl.host = baseUrl.host;

    if (reqUrl.href === original) return input;

    log.debug("Rewrote request origin", {
      from: new URL(original).host,
      to: baseUrl.host,
    });

    return input instanceof Request ? new Request(reqUrl.toString(), input) : reqUrl;
  } catch (e) {
    log.warn("Failed to rewrite request origin", { error: String(e) });
    return input;
  }
}
