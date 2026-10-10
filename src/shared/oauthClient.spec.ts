import { describe, expect, it } from "bun:test";
import { replaceFetch, restoreFetchAfterEach, tokenResponse } from "../testing/fetch.ts";
import {
  createAuthorizationRequest,
  createCodeExchange,
  parseCallbackCode,
  refreshTokensOnce,
} from "./oauthClient.ts";

restoreFetchAfterEach();

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

describe("createAuthorizationRequest", () => {
  it("builds a pkce authorization url with the verifier as state", () => {
    const { url, verifier } = createAuthorizationRequest("user:inference");
    const params = new URL(url).searchParams;

    expect(params.get("scope")).toBe("user:inference");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("state")).toBe(verifier);
    expect(params.get("code_challenge")).not.toBe(verifier);
  });
});

describe("refreshTokensOnce", () => {
  it("shares one refresh between concurrent callers with the same token", async () => {
    let calls = 0;
    replaceFetch(async () => {
      calls++;
      await Bun.sleep(5);
      return tokenResponse("shared");
    });

    const [first, second] = await Promise.all([
      refreshTokensOnce("same-refresh"),
      refreshTokensOnce("same-refresh"),
    ]);

    expect(calls).toBe(1);
    expect(first).toEqual(second);
  });

  it("never hands one account's tokens to a concurrent refresh of another account", async () => {
    replaceFetch(async (_input, init) => {
      const token = new URLSearchParams(String(init?.body)).get("refresh_token");
      await Bun.sleep(5);
      return tokenResponse(String(token));
    });

    const [work, personal] = await Promise.all([
      refreshTokensOnce("work"),
      refreshTokensOnce("personal"),
    ]);

    expect(work.access).toBe("work-access");
    expect(personal.access).toBe("personal-access");
  });

  it("reports the status and body of a failed refresh", async () => {
    replaceFetch(() => new Response("invalid_grant", { status: 400 }));

    await expect(refreshTokensOnce("rejected")).rejects.toThrow(
      "Token refresh failed: 400: invalid_grant",
    );
  });

  it("allows a new refresh after the previous one settled", async () => {
    let calls = 0;
    replaceFetch(() => {
      calls++;
      return tokenResponse(`call-${calls}`);
    });

    await refreshTokensOnce("repeat");
    const second = await refreshTokensOnce("repeat");

    expect(second.access).toBe("call-2-access");
  });
});

describe("createCodeExchange", () => {
  it("exchanges a pasted callback url once for duplicate submissions", async () => {
    const codes: string[] = [];
    replaceFetch(async (_input, init) => {
      codes.push(String(new URLSearchParams(String(init?.body)).get("code")));
      await Bun.sleep(5);
      return tokenResponse("browser");
    });
    const exchange = createCodeExchange("verifier");

    const [first, second] = await Promise.all([
      exchange("https://platform.claude.com/oauth/code/callback?code=abc&state=verifier"),
      exchange("abc#verifier"),
    ]);

    expect(codes).toEqual(["abc"]);
    expect(first.access).toBe("browser-access");
    expect(second).toEqual(first);
  });

  it("allows a retry after a failed exchange", async () => {
    let calls = 0;
    replaceFetch(() => {
      calls++;
      return calls === 1 ? new Response("bad code", { status: 400 }) : tokenResponse("retry");
    });
    const exchange = createCodeExchange("verifier");

    await expect(exchange("wrong")).rejects.toThrow("Token exchange failed: 400: bad code");
    expect((await exchange("right")).access).toBe("retry-access");
  });
});
