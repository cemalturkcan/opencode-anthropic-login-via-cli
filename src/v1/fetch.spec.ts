import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { replaceFetch, restoreFetchAfterEach, tokenResponse } from "../testing/fetch.ts";
import {
  expiredTokens,
  installClaudeStub,
  resetSandbox,
  validTokens,
  writeCcsInstance,
  writeCliCredentials,
} from "../testing/fixtures.ts";
import { createCustomFetch, type AuthState, type AuthStore } from "./fetch.ts";

type SentRequest = { url: string; headers: Headers; body: string; init?: BunFetchRequestInit };

const hour = 60 * 60 * 1000;

restoreFetchAfterEach();
beforeEach(resetSandbox);
afterEach(() => {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_INSECURE;
});

function recordingStore(): AuthStore & { saved: AuthState[] } {
  const saved: AuthState[] = [];
  return {
    saved,
    auth: {
      set: async ({ body }) => {
        saved.push(body);
      },
    },
  };
}

function freshAuth(): AuthState {
  return {
    type: "oauth",
    access: "current-access",
    refresh: "current-refresh",
    expires: Date.now() + hour,
  };
}

function messagesBody(): string {
  return JSON.stringify({
    model: "claude-sonnet-4-20250514",
    tools: [{ name: "bash" }],
    messages: [{ role: "user", content: "Hello" }],
  });
}

async function record(input: RequestInfo | URL, init?: BunFetchRequestInit): Promise<SentRequest> {
  const request = new Request(input, init);
  return {
    url: request.url,
    headers: new Headers(init?.headers),
    body: await request.text(),
    init,
  };
}

function jsonPost(body = messagesBody()): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body };
}

describe("createCustomFetch", () => {
  it("passes api-key requests through untouched", async () => {
    let sent: SentRequest | undefined;
    replaceFetch(async (input, init) => {
      sent = await record(input, init);
      return new Response("ok");
    });
    const customFetch = createCustomFetch(async () => ({ type: "api" }), recordingStore());

    await customFetch("https://api.anthropic.com/v1/messages", jsonPost());

    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(sent?.body ?? "{}").tools[0].name).toBe("bash");
  });

  it("signs, transforms and tags oauth requests like claude code", async () => {
    let sent: SentRequest | undefined;
    replaceFetch(async (input, init) => {
      sent = await record(input, init);
      return new Response("ok");
    });
    const customFetch = createCustomFetch(async () => freshAuth(), recordingStore());

    await customFetch("https://api.anthropic.com/v1/messages", {
      ...jsonPost(),
      headers: {
        "content-type": "application/json",
        "x-api-key": "leak",
        "anthropic-beta": "custom",
      },
    });

    expect(new URL(sent?.url ?? "").searchParams.get("beta")).toBe("true");
    expect(sent?.headers.get("authorization")).toBe("Bearer current-access");
    expect(sent?.headers.get("x-app")).toBe("cli");
    expect(sent?.headers.has("x-api-key")).toBe(false);
    expect(sent?.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(sent?.headers.get("anthropic-beta")).toContain("custom");
    expect(JSON.parse(sent?.body ?? "{}").tools[0].name).toBe("mcp_Bash");
  });

  it("tags requests with one claude code session and the account metadata", async () => {
    const sent: SentRequest[] = [];
    replaceFetch(async (input, init) => {
      sent.push(await record(input, init));
      return new Response("ok");
    });
    const customFetch = createCustomFetch(async () => freshAuth(), recordingStore());

    await customFetch("https://api.anthropic.com/v1/messages", jsonPost());
    await customFetch("https://api.anthropic.com/v1/messages", jsonPost());
    const sessionId = sent[0].headers.get("x-claude-code-session-id");

    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[1].headers.get("x-claude-code-session-id")).toBe(sessionId);
    expect(JSON.parse(JSON.parse(sent[0].body).metadata.user_id)).toMatchObject({
      account_uuid: "current-access-uuid",
      session_id: sessionId,
    });
  });

  it("transforms the body of a Request input", async () => {
    let sent: SentRequest | undefined;
    replaceFetch(async (input, init) => {
      sent = await record(input, init);
      return new Response("ok");
    });
    const customFetch = createCustomFetch(async () => freshAuth(), recordingStore());

    await customFetch(new Request("https://api.anthropic.com/v1/messages", jsonPost()));

    expect(JSON.parse(sent?.body ?? "{}").tools[0].name).toBe("mcp_Bash");
  });

  it("restores tool names in the response", async () => {
    replaceFetch(() => Response.json({ content: [{ type: "tool_use", name: "mcp_Bash" }] }));
    const customFetch = createCustomFetch(async () => freshAuth(), recordingStore());

    const response = await customFetch("https://api.anthropic.com/v1/messages", jsonPost());

    expect(await response.text()).toContain('"name": "bash"');
  });

  it("routes through ANTHROPIC_BASE_URL and honors ANTHROPIC_INSECURE", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    process.env.ANTHROPIC_INSECURE = "1";
    let sent: SentRequest | undefined;
    replaceFetch(async (input, init) => {
      sent = await record(input, init);
      return new Response("ok");
    });
    const customFetch = createCustomFetch(async () => freshAuth(), recordingStore());

    await customFetch("https://api.anthropic.com/v1/messages", jsonPost());

    expect(new URL(sent?.url ?? "").host).toBe("proxy.example.com");
    expect(sent?.init?.tls).toEqual({ rejectUnauthorized: false });
  });

  it("restores /v1 and beta=true when the sdk used ANTHROPIC_BASE_URL as its base url", async () => {
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:18766";
    let sent: SentRequest | undefined;
    replaceFetch(async (input, init) => {
      sent = await record(input, init);
      return new Response("ok");
    });

    await createCustomFetch(async () => freshAuth(), recordingStore())(
      "http://127.0.0.1:18766/messages",
      jsonPost(),
    );

    expect(sent?.url).toBe("http://127.0.0.1:18766/v1/messages?beta=true");
  });

  it("refreshes an expiring token with the latest stored refresh token", async () => {
    const store = recordingStore();
    const requests: SentRequest[] = [];
    replaceFetch(async (input, init) => {
      const sent = await record(input, init);
      requests.push(sent);
      return sent.url.includes("/oauth/token") ? tokenResponse("rotated") : new Response("ok");
    });
    const stale: AuthState = {
      type: "oauth",
      access: "old",
      refresh: "snapshot-refresh",
      expires: 0,
    };
    const latest: AuthState = { ...stale, refresh: "latest-refresh" };
    let reads = 0;
    const customFetch = createCustomFetch(async () => (reads++ === 0 ? stale : latest), store);

    await customFetch("https://api.anthropic.com/v1/messages", jsonPost());

    expect(JSON.parse(requests[0].body).refresh_token).toBe("latest-refresh");
    expect(requests[1].headers.get("authorization")).toBe("Bearer rotated-access");
    expect(store.saved).toEqual([
      {
        type: "oauth",
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: expect.any(Number),
      },
    ]);
  });

  it("falls back to claude cli credentials when the oauth refresh fails", async () => {
    await writeCliCredentials(validTokens("cli"));
    const store = recordingStore();
    const authorizations: (string | null)[] = [];
    replaceFetch(async (input, init) => {
      const sent = await record(input, init);
      if (sent.url.includes("/oauth/token")) return new Response("invalid_grant", { status: 400 });
      authorizations.push(sent.headers.get("authorization"));
      return new Response("ok");
    });
    const expired: AuthState = {
      type: "oauth",
      access: "old",
      refresh: "dead-refresh",
      expires: 0,
    };

    await createCustomFetch(async () => expired, store)(
      "https://api.anthropic.com/v1/messages",
      jsonPost(),
    );

    expect(authorizations).toEqual(["Bearer cli-access"]);
    expect(store.saved[0]?.access).toBe("cli-access");
  });

  it("fails with 401 instead of sending an unauthenticated request", async () => {
    await installClaudeStub();
    let apiCalls = 0;
    replaceFetch(async (input, init) => {
      const sent = await record(input, init);
      if (sent.url.includes("/oauth/token")) return new Response("invalid_grant", { status: 400 });
      apiCalls++;
      return new Response("ok");
    });
    const expired: AuthState = { type: "oauth", refresh: "dead-refresh", expires: 0 };

    const response = await createCustomFetch(async () => expired, recordingStore())(
      "https://api.anthropic.com/v1/messages",
      jsonPost(),
    );

    expect(response.status).toBe(401);
    expect(apiCalls).toBe(0);
  });

  it("retries a 401 once with alternate cli credentials", async () => {
    await writeCliCredentials(validTokens("cli"));
    const store = recordingStore();
    const authorizations: (string | null)[] = [];
    const accounts: string[] = [];
    replaceFetch(async (input, init) => {
      const sent = await record(input, init);
      authorizations.push(sent.headers.get("authorization"));
      accounts.push(JSON.parse(JSON.parse(sent.body).metadata.user_id).account_uuid);
      return authorizations.length === 1
        ? new Response("unauthorized", { status: 401 })
        : new Response("ok");
    });

    const response = await createCustomFetch(
      async () => freshAuth(),
      store,
    )(new Request("https://api.anthropic.com/v1/messages", jsonPost()));

    expect(await response.text()).toBe("ok");
    expect(authorizations).toEqual(["Bearer current-access", "Bearer cli-access"]);
    expect(accounts).toEqual(["current-access-uuid", "cli-access-uuid"]);
    expect(store.saved[0]?.access).toBe("cli-access");
  });

  it("switches to a ccs account on an ordinary rate limit", async () => {
    await writeCliCredentials(validTokens("current"));
    await writeCcsInstance("work", validTokens("work"));
    const authorizations: (string | null)[] = [];
    replaceFetch(async (input, init) => {
      const sent = await record(input, init);
      authorizations.push(sent.headers.get("authorization"));
      return authorizations.length === 1
        ? new Response("rate limited", { status: 429 })
        : new Response("ok");
    });

    await createCustomFetch(async () => freshAuth(), recordingStore())(
      "https://api.anthropic.com/v1/messages",
      jsonPost(),
    );

    expect(authorizations).toEqual(["Bearer current-access", "Bearer work-access"]);
  });

  it("returns a terminal 429 without switching accounts", async () => {
    await writeCcsInstance("work", validTokens("work"));
    let calls = 0;
    replaceFetch(() => {
      calls++;
      return new Response('{"error":{"type":"billing_error"}}', { status: 429 });
    });
    const store = recordingStore();

    const response = await createCustomFetch(async () => freshAuth(), store)(
      "https://api.anthropic.com/v1/messages",
      jsonPost(),
    );

    expect(response.status).toBe(429);
    expect(await response.text()).toContain("billing_error");
    expect(calls).toBe(1);
    expect(store.saved).toEqual([]);
  });

  it("returns the original error when no alternate account exists", async () => {
    await writeCliCredentials(expiredTokens("cli"));
    replaceFetch(() => new Response("overloaded", { status: 529 }));

    const response = await createCustomFetch(async () => freshAuth(), recordingStore())(
      "https://api.anthropic.com/v1/messages",
      jsonPost(),
    );

    expect(response.status).toBe(529);
    expect(await response.text()).toBe("overloaded");
  });
});
