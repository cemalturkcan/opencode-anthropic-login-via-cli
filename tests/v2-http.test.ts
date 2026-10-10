import { describe, expect, it } from "bun:test";
import { setupV2Http } from "../src/v2-http.ts";

const oauth = {
  type: "oauth",
  methodID: "claude-cli",
  access: "fixture-access",
  refresh: "fixture-refresh",
  expires: Date.now() + 60 * 60 * 1000,
};

async function setup(credential: unknown) {
  const hooks = new Map<string, (event: any) => Promise<void>>();
  const context = {
    integration: {
      connection: {
        active: async () => ({ type: "credential", id: "fixture", method: "fixture" }),
        resolve: async () => credential,
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => Promise<void>) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
  };
  await setupV2Http(context as never);
  return hooks;
}

describe("V2 native HTTP hooks", () => {
  it("transforms OAuth requests for primary and auxiliary request kinds", async () => {
    const requestHook = (await setup(oauth)).get("http.request")!;

    for (const kind of ["primary", "compaction", "title", "generate"]) {
      const controller = new AbortController();
      const event = {
        kind,
        request: new Request("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-beta": "custom-beta",
            "x-api-key": "discard-this",
          },
          body: JSON.stringify({ model: "claude-sonnet-4-20250514", tools: [{ name: "bash" }] }),
          signal: controller.signal,
        }),
      };
      await requestHook(event);

      expect(event.request.headers.get("authorization")).toBe("Bearer fixture-access");
      expect(event.request.headers.has("x-api-key")).toBe(false);
      expect(event.request.headers.get("x-app")).toBe("cli");
      expect(event.request.headers.get("anthropic-beta")).toContain("custom-beta");
      expect(event.request.headers.get("anthropic-beta")).not.toContain("context-1m-2025-08-07");
      expect(new URL(event.request.url).searchParams.get("beta")).toBe("true");
      expect(JSON.parse(await event.request.text()).tools[0].name).toBe("mcp_Bash");
      controller.abort();
      expect(event.request.signal.aborted).toBe(true);
    }
  });

  it("leaves API-key requests unchanged", async () => {
    const requestHook = (await setup({ type: "key", key: "fixture-api-key" })).get("http.request")!;
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "fixture-api-key" },
      body: JSON.stringify({ tools: [{ name: "bash" }] }),
    });
    const event = { kind: "primary", request };

    await requestHook(event);

    expect(event.request).toBe(request);
    expect(event.request.headers.get("x-api-key")).toBe("fixture-api-key");
    expect(JSON.parse(await event.request.text()).tools[0].name).toBe("bash");
  });

  it("restores tool names from OAuth SSE responses", async () => {
    const responseHook = (await setup(oauth)).get("http.response")!;
    const event = {
      kind: "primary",
      response: new Response('data: {"name":"mcp_Bash"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    };

    await responseHook(event);

    expect(event.response.status).toBe(200);
    expect(await event.response.text()).toBe('data: {"name": "bash"}\n\n');
  });

  it("passes an actual HTTP authorization failure through unchanged", async () => {
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
      const hooks = await setup(oauth);
      const event = {
        kind: "primary",
        request: new Request(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-20250514", tools: [{ name: "bash" }] }),
        }),
      };
      await hooks.get("http.request")!(event);
      const response = await fetch(event.request);
      const responseEvent = { kind: "primary", request: event.request, response };
      await hooks.get("http.response")!(responseEvent);

      expect(received?.authorization).toBe("Bearer fixture-access");
      expect(JSON.parse(received?.body ?? "{}").tools[0].name).toBe("mcp_Bash");
      expect(responseEvent.response.status).toBe(401);
      expect(await responseEvent.response.text()).toBe("unauthorized");
    } finally {
      server.stop(true);
    }
  });
});
