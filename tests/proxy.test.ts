import { afterEach, describe, expect, it } from "bun:test";
import { resolveBaseUrl, isInsecure, rewriteOrigin, resetProxyCache } from "../src/proxy.ts";

describe("resolveBaseUrl", () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    resetProxyCache();
  });

  it("returns null when env var is unset", () => {
    expect(resolveBaseUrl()).toBeNull();
  });

  it("returns null when env var is empty", () => {
    process.env.ANTHROPIC_BASE_URL = "  ";
    expect(resolveBaseUrl()).toBeNull();
  });

  it("parses a valid HTTPS URL", () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    const url = resolveBaseUrl();
    expect(url).not.toBeNull();
    expect(url!.host).toBe("proxy.example.com");
    expect(url!.protocol).toBe("https:");
  });

  it("parses a valid HTTP URL", () => {
    process.env.ANTHROPIC_BASE_URL = "http://localhost:8080";
    const url = resolveBaseUrl();
    expect(url).not.toBeNull();
    expect(url!.host).toBe("localhost:8080");
    expect(url!.protocol).toBe("http:");
  });

  it("rejects URLs with unsupported protocols", () => {
    process.env.ANTHROPIC_BASE_URL = "ftp://proxy.example.com";
    expect(resolveBaseUrl()).toBeNull();
  });

  it("rejects URLs with embedded credentials", () => {
    process.env.ANTHROPIC_BASE_URL = "https://user:pass@proxy.example.com";
    expect(resolveBaseUrl()).toBeNull();
  });

  it("rejects invalid URL strings", () => {
    process.env.ANTHROPIC_BASE_URL = "not a url";
    expect(resolveBaseUrl()).toBeNull();
  });

  it("rejects URLs with a path component", () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com/anthropic";
    expect(resolveBaseUrl()).toBeNull();
  });

  it("trims whitespace", () => {
    process.env.ANTHROPIC_BASE_URL = "  https://proxy.example.com  ";
    const url = resolveBaseUrl();
    expect(url).not.toBeNull();
    expect(url!.host).toBe("proxy.example.com");
  });
});

describe("isInsecure", () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_INSECURE;
    resetProxyCache();
  });

  it("returns false when ANTHROPIC_BASE_URL is unset", () => {
    process.env.ANTHROPIC_INSECURE = "1";
    expect(isInsecure()).toBe(false);
  });

  it("returns false when ANTHROPIC_INSECURE is unset", () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    expect(isInsecure()).toBe(false);
  });

  it('returns true when both set and INSECURE is "1"', () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    process.env.ANTHROPIC_INSECURE = "1";
    expect(isInsecure()).toBe(true);
  });

  it('returns true when both set and INSECURE is "true"', () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    process.env.ANTHROPIC_INSECURE = "true";
    expect(isInsecure()).toBe(true);
  });

  it("returns false for other INSECURE values", () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    process.env.ANTHROPIC_INSECURE = "yes";
    expect(isInsecure()).toBe(false);
  });
});

describe("rewriteOrigin", () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    resetProxyCache();
  });

  it("returns input unchanged when no base URL is set", () => {
    const input = "https://api.anthropic.com/v1/messages";
    expect(rewriteOrigin(input)).toBe(input);
  });

  it("rewrites origin for a string URL", () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    const result = rewriteOrigin("https://api.anthropic.com/v1/messages?beta=true");

    expect(result).toBeInstanceOf(URL);
    const url = result as URL;
    expect(url.host).toBe("proxy.example.com");
    expect(url.pathname).toBe("/v1/messages");
    expect(url.searchParams.get("beta")).toBe("true");
  });

  it("rewrites origin for a URL object", () => {
    process.env.ANTHROPIC_BASE_URL = "http://localhost:8080";
    const input = new URL("https://api.anthropic.com/v1/messages");
    const result = rewriteOrigin(input) as URL;

    expect(result.host).toBe("localhost:8080");
    expect(result.protocol).toBe("http:");
    expect(result.pathname).toBe("/v1/messages");
  });

  it("rewrites origin for a Request object", () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    const input = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
    });
    const result = rewriteOrigin(input);

    expect(result).toBeInstanceOf(Request);
    const req = result as Request;
    expect(new URL(req.url).host).toBe("proxy.example.com");
    expect(req.method).toBe("POST");
  });

  it("preserves path and query parameters", () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    const result = rewriteOrigin("https://api.anthropic.com/v1/messages?beta=true&foo=bar") as URL;

    expect(result.pathname).toBe("/v1/messages");
    expect(result.searchParams.get("beta")).toBe("true");
    expect(result.searchParams.get("foo")).toBe("bar");
  });

  it("returns input when same origin (no-op)", () => {
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    const input = "https://api.anthropic.com/v1/messages";
    expect(rewriteOrigin(input)).toBe(input);
  });
});
