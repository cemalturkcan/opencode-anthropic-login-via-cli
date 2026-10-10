import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { replaceFetch, restoreFetchAfterEach } from "../testing/fetch.ts";
import { resetSandbox } from "../testing/fixtures.ts";
import { createV2Context, oauthCredential } from "../testing/v2Context.ts";
import { createAccountRouter, type AccountIntegration, type SelectedAccount } from "./accounts.ts";
import { setupV2Http } from "./http.ts";
import type { SubscriptionPricing } from "./pricing.ts";

type RequestEvent = { sessionID?: string; kind: string; request: Request };
type ResponseEvent = { sessionID?: string; kind: string; request: Request; response: Response };

restoreFetchAfterEach();
beforeEach(resetSandbox);
afterEach(() => {
  delete process.env.ANTHROPIC_BASE_URL;
});

function recordingPricing(): SubscriptionPricing & { states: boolean[] } {
  const states: boolean[] = [];
  return { states, sync: async (subscription) => void states.push(subscription) };
}

async function setup(credential = oauthCredential(), pricing = recordingPricing()) {
  replaceFetch(() => new Response("unexpected upstream call", { status: 500 }));
  const v2 = createV2Context(credential);
  const ctx = v2.context as { integration: AccountIntegration; session: never };
  await setupV2Http(createAccountRouter(ctx.integration), ctx.session, pricing);
  return v2;
}

function messagesRequest(init: RequestInit = {}): Request {
  return new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "discard-this",
      "anthropic-beta": "custom-beta",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", tools: [{ name: "bash" }] }),
    ...init,
  });
}

describe("V2 http.request hook", () => {
  it.each(["primary", "compaction", "title", "generate"])(
    "signs and transforms %s requests for oauth connections",
    async (kind) => {
      const v2 = await setup();
      const controller = new AbortController();

      const { request } = await v2.fire<RequestEvent>("http.request", {
        kind,
        request: messagesRequest({ signal: controller.signal }),
      });

      expect(request.headers.get("authorization")).toBe("Bearer fixture-access");
      expect(request.headers.has("x-api-key")).toBe(false);
      expect(request.headers.get("x-app")).toBe("cli");
      expect(request.headers.get("anthropic-beta")).toContain("custom-beta");
      expect(request.headers.get("anthropic-beta")).not.toContain("context-1m-2025-08-07");
      expect(new URL(request.url).searchParams.get("beta")).toBe("true");
      expect(JSON.parse(await request.text()).tools[0].name).toBe("mcp_Bash");
      controller.abort();
      expect(request.signal.aborted).toBe(true);
    },
  );

  it("tags requests with a stable claude code session and the account metadata", async () => {
    const v2 = await setup();

    const first = await v2.fire<RequestEvent>("http.request", {
      sessionID: "opencode-session",
      kind: "primary",
      request: messagesRequest(),
    });
    const second = await v2.fire<RequestEvent>("http.request", {
      sessionID: "opencode-session",
      kind: "primary",
      request: messagesRequest(),
    });
    const sessionId = first.request.headers.get("x-claude-code-session-id");

    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.request.headers.get("x-claude-code-session-id")).toBe(sessionId);
    expect(JSON.parse(JSON.parse(await first.request.text()).metadata.user_id)).toMatchObject({
      account_uuid: "fixture-access-uuid",
      session_id: sessionId,
    });
  });

  it("drops a stale content-length after rewriting the body", async () => {
    const v2 = await setup();
    const original = messagesRequest();
    original.headers.set("content-length", "10");

    const { request } = await v2.fire<RequestEvent>("http.request", {
      kind: "primary",
      request: original,
    });

    expect(request.headers.get("content-length")).not.toBe("10");
  });

  it("routes through ANTHROPIC_BASE_URL", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    const v2 = await setup();

    const { request } = await v2.fire<RequestEvent>("http.request", {
      kind: "primary",
      request: messagesRequest(),
    });

    expect(new URL(request.url).host).toBe("proxy.example.com");
  });

  it("restores /v1 and beta=true when the host used ANTHROPIC_BASE_URL as its base url", async () => {
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:18767";
    const v2 = await setup();

    const { request } = await v2.fire<RequestEvent>("http.request", {
      kind: "primary",
      request: messagesRequest(),
    });
    const fromBaseUrl = await v2.fire<RequestEvent>("http.request", {
      kind: "primary",
      request: new Request("http://127.0.0.1:18767/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5-5" }),
      }),
    });

    expect(request.url).toBe("http://127.0.0.1:18767/v1/messages?beta=true");
    expect(fromBaseUrl.request.url).toBe("http://127.0.0.1:18767/v1/messages?beta=true");
  });

  it("leaves api-key requests unchanged", async () => {
    const v2 = await setup({ type: "key", key: "fixture-api-key" } as never);
    const original = messagesRequest();

    const { request } = await v2.fire<RequestEvent>("http.request", {
      kind: "primary",
      request: original,
    });

    expect(request).toBe(original);
    expect(JSON.parse(await request.text()).tools[0].name).toBe("bash");
  });

  it("syncs subscription pricing with the active connection on every request", async () => {
    const pricing = recordingPricing();
    const v2 = await setup(oauthCredential(), pricing);

    await v2.fire<RequestEvent>("http.request", { kind: "primary", request: messagesRequest() });
    v2.connect({ type: "key", key: "fixture-api-key" } as never);
    await v2.fire<RequestEvent>("http.request", { kind: "primary", request: messagesRequest() });

    expect(pricing.states).toEqual([true, false]);
  });
});

describe("V2 http.response hook", () => {
  it("restores tool names in streamed responses", async () => {
    const v2 = await setup();

    const { response } = await v2.fire<ResponseEvent>("http.response", {
      kind: "primary",
      request: messagesRequest(),
      response: new Response('data: {"name":"mcp_Bash"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    });

    expect(await response.text()).toBe('data: {"name": "bash"}\n\n');
  });

  it("restores tool names in non-streaming json responses", async () => {
    const v2 = await setup();

    const { response } = await v2.fire<ResponseEvent>("http.response", {
      kind: "generate",
      request: messagesRequest(),
      response: Response.json({ content: [{ type: "tool_use", name: "mcp_Bash" }] }),
    });

    expect(await response.text()).toContain('"name": "bash"');
  });

  it("leaves api-key responses untouched", async () => {
    const v2 = await setup({ type: "key", key: "fixture-api-key" } as never);
    const original = Response.json({ content: [{ type: "tool_use", name: "mcp_Bash" }] });

    const { response } = await v2.fire<ResponseEvent>("http.response", {
      kind: "primary",
      request: messagesRequest(),
      response: original,
    });

    expect(response).toBe(original);
  });

  it("replays a rate-limited request with another account", async () => {
    const v2 = await setup();
    v2.addAccount("work", oauthCredential("ccs-work", "work"));
    const authorizations: (string | null)[] = [];
    const accounts: string[] = [];
    replaceFetch(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      authorizations.push(request.headers.get("authorization"));
      accounts.push(JSON.parse(JSON.parse(await request.text()).metadata.user_id).account_uuid);
      return Response.json({ content: [{ type: "tool_use", name: "mcp_Bash" }] });
    });
    const { request } = await v2.fire<RequestEvent>("http.request", {
      sessionID: "s",
      kind: "primary",
      request: messagesRequest(),
    });

    const { response } = await v2.fire<ResponseEvent>("http.response", {
      sessionID: "s",
      kind: "primary",
      request,
      response: new Response('{"error":{"type":"rate_limit_error"}}', { status: 429 }),
    });

    expect(authorizations).toEqual(["Bearer work"]);
    expect(accounts).toEqual(["work-uuid"]);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"name": "bash"');
  });

  it.each([401, 500])("does not replay a %i", async (status) => {
    const v2 = await setup();
    v2.addAccount("work", oauthCredential("ccs-work", "work"));
    let upstreamCalls = 0;
    replaceFetch(() => {
      upstreamCalls++;
      return new Response("ok");
    });
    const { request } = await v2.fire<RequestEvent>("http.request", {
      kind: "primary",
      request: messagesRequest(),
    });

    const { response } = await v2.fire<ResponseEvent>("http.response", {
      kind: "primary",
      request,
      response: new Response("failure", { status }),
    });

    expect(response.status).toBe(status);
    expect(upstreamCalls).toBe(0);
  });

  it("replays the exact prepared request for the other account", async () => {
    const failovers: number[] = [];
    const work = oauthCredential("ccs-work", "work");
    const primary = oauthCredential("claude-cli", "primary");
    const connection = { type: "credential", id: "c", label: "c", method: "oauth" } as never;
    const router = {
      hasCredentialFrom: async () => false,
      select: async () => ({ connection, credential: primary }),
      failover: async (_failed: SelectedAccount, coolUntil: number) => {
        failovers.push(coolUntil);
        return { connection, credential: work };
      },
    };
    const v2 = createV2Context(primary);
    await setupV2Http(router, (v2.context as { session: never }).session, recordingPricing());
    const controller = new AbortController();
    const { request } = await v2.fire<RequestEvent>("http.request", {
      kind: "primary",
      request: messagesRequest({ signal: controller.signal }),
    });
    request.headers.set("content-length", "5");
    const sentBody = JSON.parse(await request.clone().text());
    let replayed: Request | undefined;
    replaceFetch((input) => {
      replayed = input instanceof Request ? input : new Request(input);
      return new Response("ok");
    });

    await v2.fire<ResponseEvent>("http.response", {
      kind: "primary",
      request,
      response: new Response("limited", {
        status: 429,
        headers: { "anthropic-ratelimit-unified-reset": "2000000000" },
      }),
    });
    const replayedBody = JSON.parse(await replayed!.clone().text());

    expect(failovers).toEqual([2_000_000_000_000]);
    expect(replayed?.url).toBe(request.url);
    expect(replayed?.headers.get("authorization")).toBe("Bearer work");
    expect(replayed?.headers.has("content-length")).toBe(false);
    expect({ ...replayedBody, metadata: undefined }).toEqual({ ...sentBody, metadata: undefined });
    controller.abort();
    expect(replayed?.signal.aborted).toBe(true);
  });

  it("keeps a terminal rate limit without switching accounts", async () => {
    const v2 = await setup();
    v2.addAccount("work", oauthCredential("ccs-work", "work"));
    const { request } = await v2.fire<RequestEvent>("http.request", {
      sessionID: "s",
      kind: "primary",
      request: messagesRequest(),
    });

    const { response } = await v2.fire<ResponseEvent>("http.response", {
      sessionID: "s",
      kind: "primary",
      request,
      response: new Response('{"error":{"type":"billing_error"}}', { status: 429 }),
    });

    expect(response.status).toBe(429);
  });

  it("restores tool names when the host hands back a different request object", async () => {
    const v2 = await setup();

    const { response } = await v2.fire<ResponseEvent>("http.response", {
      sessionID: "s",
      kind: "primary",
      request: messagesRequest(),
      response: Response.json({ content: [{ type: "tool_use", name: "mcp_Bash" }] }),
    });

    expect(await response.text()).toContain('"name": "bash"');
  });

  it("passes a real 401 from the server through unchanged", async () => {
    let received: { authorization: string | null; body: string } | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received = {
          authorization: request.headers.get("authorization"),
          body: await request.text(),
        };
        return new Response("unauthorized", { status: 401 });
      },
    });

    try {
      const v2 = await setup();
      const { request } = await v2.fire<RequestEvent>("http.request", {
        kind: "primary",
        request: new Request(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-20250514", tools: [{ name: "bash" }] }),
        }),
      });
      const { response } = await v2.fire<ResponseEvent>("http.response", {
        kind: "primary",
        request,
        response: await Bun.fetch(request),
      });

      expect(received?.authorization).toBe("Bearer fixture-access");
      expect(JSON.parse(received?.body ?? "{}").tools[0].name).toBe("mcp_Bash");
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("unauthorized");
    } finally {
      server.stop(true);
    }
  });
});
