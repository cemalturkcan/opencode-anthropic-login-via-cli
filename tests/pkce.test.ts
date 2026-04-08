import { describe, expect, it } from "bun:test";
import { parseCallbackCode } from "../src/pkce.ts";

describe("parseCallbackCode", () => {
  it("extracts code from a full callback URL", () => {
    const input = "https://platform.claude.com/oauth/code/callback?code=abc123&state=xyz";

    expect(parseCallbackCode(input)).toBe("abc123");
  });

  it("extracts code from a callback URL with extra parameters", () => {
    const input = "https://platform.claude.com/oauth/code/callback?code=abc123&state=xyz&foo=bar";

    expect(parseCallbackCode(input)).toBe("abc123");
  });

  it("extracts code from a query string without URL", () => {
    expect(parseCallbackCode("code=abc123&state=xyz")).toBe("abc123");
  });

  it("extracts code from a query string with a hash fragment", () => {
    expect(parseCallbackCode("code=abc123#state=xyz")).toBe("abc123");
  });

  it("extracts code from a query string with a leading question mark", () => {
    expect(parseCallbackCode("?code=abc123&state=xyz")).toBe("abc123");
  });

  it("extracts code from hash-separated format", () => {
    expect(parseCallbackCode("abc123#xyz")).toBe("abc123");
  });

  it("returns plain code as-is", () => {
    expect(parseCallbackCode("abc123")).toBe("abc123");
  });

  it("trims whitespace from input", () => {
    expect(parseCallbackCode("  abc123  ")).toBe("abc123");
  });

  it("trims whitespace around a full URL", () => {
    const input = "  https://platform.claude.com/oauth/code/callback?code=abc123&state=xyz  ";

    expect(parseCallbackCode(input)).toBe("abc123");
  });

  it("throws for a URL without a code parameter", () => {
    expect(() => parseCallbackCode("https://example.com/callback?state=xyz")).toThrow(
      "OAuth callback URL is missing a code parameter",
    );
  });

  it("throws for a URL with an error parameter", () => {
    expect(() =>
      parseCallbackCode("https://example.com/callback?error=access_denied&state=xyz"),
    ).toThrow("OAuth error: access_denied");
  });

  it("returns empty string for an empty code in a query string", () => {
    expect(parseCallbackCode("code=&state=xyz")).toBe("");
  });

  it("returns empty string for an empty code in a URL", () => {
    expect(
      parseCallbackCode("https://platform.claude.com/oauth/code/callback?code=&state=xyz"),
    ).toBe("");
  });

  it("handles empty string", () => {
    expect(parseCallbackCode("")).toBe("");
  });
});
