import { describe, expect, it } from "bun:test";
import { jsonField, replaceFetch, restoreFetchAfterEach, tokenResponse } from "../testing/fetch.ts";
import { oauthScopes, refreshScopes } from "./constants.ts";
import {
  createAuthorizationRequest,
  createCodeExchange,
  parseCallbackCode,
  parseCallbackState,
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

describe("parseCallbackState", () => {
  it.each([
    ["https://platform.claude.com/oauth/code/callback?code=abc&state=xyz", "xyz"],
    ["code=abc&state=xyz", "xyz"],
    ["code=abc#state=xyz", "xyz"],
    ["abc#xyz", "xyz"],
    ["  abc#xyz  ", "xyz"],
  ])("reads the state from %p", (input, state) => {
    expect(parseCallbackState(input)).toBe(state);
  });

  it.each(["abc", "code=abc", "https://platform.claude.com/oauth/code/callback?code=abc"])(
    "returns null when %p carries no state",
    (input) => {
      expect(parseCallbackState(input)).toBeNull();
    },
  );
});

describe("createAuthorizationRequest", () => {
  it("builds a pkce authorization url with claude code scopes", () => {
    const { url, verifier } = createAuthorizationRequest();
    const params = new URL(url).searchParams;

    expect(params.get("scope")).toBe(oauthScopes);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).not.toBe(verifier);
  });

  it("uses a state that is independent of the pkce verifier", () => {
    const { url, verifier, state } = createAuthorizationRequest();

    expect(state).not.toBe(verifier);
    expect(new URL(url).searchParams.get("state")).toBe(state);
    expect(url).not.toContain(verifier);
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
      const token = jsonField(init?.body, "refresh_token");
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

  it("sends a json refresh request with the claude code scopes", async () => {
    let sent: { contentType: string | null; body: string } | undefined;
    replaceFetch((_input, init) => {
      sent = {
        contentType: new Headers(init?.headers).get("content-type"),
        body: String(init?.body),
      };
      return tokenResponse("json");
    });

    await refreshTokensOnce("json-refresh");

    expect(sent?.contentType).toBe("application/json");
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({
      grant_type: "refresh_token",
      refresh_token: "json-refresh",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      scope: refreshScopes,
    });
  });

  it("never asks a refresh for org:create_api_key, which claude.ai tokens are not granted", () => {
    expect(refreshScopes).not.toContain("org:create_api_key");
    expect(oauthScopes).toContain("org:create_api_key");
  });

  it("retries without a scope when the token was granted fewer scopes", async () => {
    const scopes: (string | null)[] = [];
    replaceFetch((_input, init) => {
      scopes.push(jsonField(init?.body, "scope"));
      return scopes.length === 1
        ? Response.json({ error: "invalid_scope" }, { status: 400 })
        : tokenResponse("narrow");
    });

    expect((await refreshTokensOnce("narrow-refresh")).access).toBe("narrow-access");
    expect(scopes).toEqual([refreshScopes, null]);
  });

  it("makes a single request when the refresh fails for another reason", async () => {
    let calls = 0;
    replaceFetch(() => {
      calls++;
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });

    await expect(refreshTokensOnce("revoked-refresh")).rejects.toThrow("invalid_grant");
    expect(calls).toBe(1);
  });

  it.each([
    [{ expires_in: 7200 }, 7200],
    [{}, 3600],
  ])("computes the expiry in seconds from %p", async (lifetime, seconds) => {
    replaceFetch(() => Response.json({ access_token: "a", refresh_token: "r", ...lifetime }));
    const before = Date.now();

    const { expires } = await refreshTokensOnce(`lifetime-${seconds}`);

    expect(expires).toBeGreaterThanOrEqual(before + seconds * 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + seconds * 1000);
  });

  it("keeps the old refresh token when the response does not rotate it", async () => {
    replaceFetch(() => Response.json({ access_token: "new-access", expires_in: 3600 }));

    expect(await refreshTokensOnce("kept-refresh")).toMatchObject({
      access: "new-access",
      refresh: "kept-refresh",
    });
  });

  it("rejects a token response without an access token", async () => {
    replaceFetch(() => Response.json({ refresh_token: "r", expires_in: 3600 }));

    await expect(refreshTokensOnce("broken")).rejects.toThrow("unexpected token response");
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
      codes.push(String(jsonField(init?.body, "code")));
      await Bun.sleep(5);
      return tokenResponse("browser");
    });
    const exchange = createCodeExchange({ verifier: "verifier", state: "state" });

    const [first, second] = await Promise.all([
      exchange("https://platform.claude.com/oauth/code/callback?code=abc&state=state"),
      exchange("abc#state"),
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
    const exchange = createCodeExchange({ verifier: "verifier", state: "state" });

    await expect(exchange("wrong")).rejects.toThrow("Token exchange failed: 400: bad code");
    expect((await exchange("right")).access).toBe("retry-access");
  });

  it("sends the verifier and the separate state to the token endpoint", async () => {
    const bodies: (string | null)[][] = [];
    replaceFetch((_input, init) => {
      bodies.push([jsonField(init?.body, "code_verifier"), jsonField(init?.body, "state")]);
      return tokenResponse("browser");
    });

    await createCodeExchange({ verifier: "verifier", state: "state" })("abc#state");

    expect(bodies).toEqual([["verifier", "state"]]);
  });

  it.each(["abc#forged", "https://platform.claude.com/oauth/code/callback?code=abc&state=forged"])(
    "rejects a pasted code whose state does not match: %p",
    async (pasted) => {
      let calls = 0;
      replaceFetch(() => {
        calls++;
        return tokenResponse("browser");
      });

      await expect(
        createCodeExchange({ verifier: "verifier", state: "state" })(pasted),
      ).rejects.toThrow("OAuth state mismatch");
      expect(calls).toBe(0);
    },
  );
});
