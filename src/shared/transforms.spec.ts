import { afterEach, describe, expect, it } from "bun:test";
import {
  createToolNameUnprefixStream,
  transformRequestBody,
  withAccountMetadata,
  withUnprefixedToolNames,
} from "./transforms.ts";

const OPENCODE_IDENTITY = "You are OpenCode, the best coding agent on the planet.";
const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

describe("transformRequestBody", () => {
  it("prefixes tool names with mcp_", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      tools: [{ name: "bash" }, { name: "read_file" }],
      messages: [],
    });

    const { body, modelId } = transformRequestBody(input);
    const parsed = JSON.parse(body);

    expect(parsed.tools[0].name).toBe("mcp_Bash");
    expect(parsed.tools[1].name).toBe("mcp_Read_file");
    expect(modelId).toBe("claude-sonnet-4-20250514");
  });

  it("replaces the legacy claude code identity with the agent sdk identity", () => {
    const input = JSON.stringify({
      model: "m",
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text", text: "Rules." },
      ],
      messages: [],
    });

    const parsed = JSON.parse(transformRequestBody(input).body);

    expect(parsed.system.map((block: { text: string }) => block.text)).toEqual([
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      "Rules.",
    ]);
  });

  it("prefixes the forced tool name in tool_choice", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      tools: [{ name: "bash" }],
      tool_choice: { type: "tool", name: "bash" },
      messages: [],
    });

    const parsed = JSON.parse(transformRequestBody(input).body);

    expect(parsed.tool_choice).toEqual({ type: "tool", name: "mcp_Bash" });
  });

  it("leaves tool_choice without a tool name unchanged", () => {
    const input = JSON.stringify({ model: "m", tool_choice: { type: "auto" }, messages: [] });

    expect(JSON.parse(transformRequestBody(input).body).tool_choice).toEqual({ type: "auto" });
  });

  it("prefixes tool_use blocks in messages", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", name: "bash", id: "t1" }],
        },
      ],
    });

    const { body } = transformRequestBody(input);
    const parsed = JSON.parse(body);

    expect(parsed.messages[0].content[0].name).toBe("mcp_Bash");
  });

  it("keeps sanitized system text in the system array with billing header", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: `${OPENCODE_IDENTITY}\n\nSee github.com/anomalyco/opencode for docs.\n\nFollow team guardrails.`,
        },
        { type: "text", text: "Prefer deterministic output." },
      ],
      messages: [{ role: "user", content: "Build the handler." }],
    });

    const { body } = transformRequestBody(input);
    const parsed = JSON.parse(body);

    expect(parsed.system[0].text).toContain("x-anthropic-billing-header");
    expect(parsed.system[1].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(parsed.system[2].text).toBe("Follow team guardrails.");
    expect(parsed.system[3].text).toBe("Prefer deterministic output.");
    expect(parsed.messages[0].content).toBe("Build the handler.");
  });

  it("keeps non-identity system blocks in the system array", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [{ type: "text", text: "Carry this instruction forward." }],
      messages: [{ role: "assistant", content: "Ready." }],
    });

    const { body } = transformRequestBody(input);
    const parsed = JSON.parse(body);

    expect(parsed.system[0].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(parsed.system[1].text).toBe("Carry this instruction forward.");
    expect(parsed.messages[0].role).toBe("assistant");
    expect(parsed.messages[0].content).toBe("Ready.");
  });

  it("removes OpenCode identity via prefix matching", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [{ type: "text", text: OPENCODE_IDENTITY }],
      messages: [{ role: "user", content: "Hello" }],
    });

    const { body } = transformRequestBody(input);
    const parsed = JSON.parse(body);

    expect(parsed.system[0].text).toContain("x-anthropic-billing-header");
    expect(parsed.system[1].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(parsed.system.length).toBe(2);
    expect(parsed.messages[0].content).toBe("Hello");
  });

  it("removes OpenCode identity variants via prefix matching", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [{ type: "text", text: "You are OpenCode, a slightly different description." }],
      messages: [{ role: "user", content: "Test" }],
    });

    const { body } = transformRequestBody(input);
    const parsed = JSON.parse(body);

    expect(parsed.system[0].text).toContain("x-anthropic-billing-header");
    expect(parsed.system[1].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(parsed.system.length).toBe(2);
  });

  it("rewrites the environment intro fingerprint during sanitization", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text:
            `${OPENCODE_IDENTITY}\n\n` +
            "Here is some useful information about the environment you are running in:\n" +
            "<env>\nWorking directory: /tmp/project\n</env>",
        },
      ],
      messages: [{ role: "user", content: "Hello" }],
    });

    const { body } = transformRequestBody(input);
    const parsed = JSON.parse(body);

    expect(parsed.system[0].text).toContain("x-anthropic-billing-header");
    expect(parsed.system[1].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(parsed.system[2].text).toBe(
      "Environment context you are running in:\n<env>\nWorking directory: /tmp/project\n</env>",
    );
    expect(parsed.system[2].text).not.toContain(
      "Here is some useful information about the environment you are running in:",
    );
    expect(parsed.messages[0].content).toBe("Hello");
  });

  it("does not include unsupported system entry types", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        { type: "text", text: "Supported instruction." },
        { type: "image", text: "Should not leak." },
        { type: "tool_result", content: [{ type: "text", text: "ignore" }] },
        { arbitrary: "object" },
      ],
      messages: [{ role: "user", content: "Handle request." }],
    });

    const { body } = transformRequestBody(input);
    const parsed = JSON.parse(body);

    expect(parsed.system[0].text).toContain("x-anthropic-billing-header");
    expect(parsed.system[1].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(parsed.system[2].text).toBe("Supported instruction.");
    expect(parsed.system.length).toBe(3);
    expect(parsed.messages[0].content).toBe("Handle request.");
  });

  it("returns raw body and null modelId on invalid JSON", () => {
    const { body, modelId } = transformRequestBody("not json");

    expect(body).toBe("not json");
    expect(modelId).toBeNull();
  });

  it("handles missing tools and messages gracefully", () => {
    const input = JSON.stringify({ model: "test" });
    const { body, modelId } = transformRequestBody(input);
    const parsed = JSON.parse(body);

    expect(parsed.model).toBe("test");
    expect(modelId).toBe("test");
  });
});

function makeReader(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const pending = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pending.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(encoder.encode(next));
    },
  }).getReader();
}

function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("createToolNameUnprefixStream", () => {
  it("strips mcp_ prefix from tool names in complete SSE events", async () => {
    const reader = makeReader(['data: {"name": "mcp_Bash", "id": "1"}\n\n']);

    const stream = createToolNameUnprefixStream(reader);
    const result = await collectStream(stream);

    expect(result).toBe('data: {"name": "bash", "id": "1"}\n\n');
  });

  it("buffers across chunk boundaries until \\n\\n", async () => {
    const reader = makeReader(['data: {"name": "mcp_', 'Bash", "id": "1"}\n\n']);

    const stream = createToolNameUnprefixStream(reader);
    const result = await collectStream(stream);

    expect(result).toContain('"name": "bash"');
  });

  it("handles \\r\\n\\r\\n boundaries via normalization", async () => {
    const reader = makeReader(['data: {"name": "mcp_Read_file"}\r\n\r\n']);

    const stream = createToolNameUnprefixStream(reader);
    const result = await collectStream(stream);

    expect(result).toContain('"name": "read_file"');
  });

  it("handles multiple events in a single chunk", async () => {
    const reader = makeReader(['data: {"name": "mcp_A"}\n\ndata: {"name": "mcp_B"}\n\n']);

    const stream = createToolNameUnprefixStream(reader);
    const result = await collectStream(stream);

    expect(result).toContain('"name": "a"');
    expect(result).toContain('"name": "b"');
  });

  it("flushes remaining buffer on stream end", async () => {
    const reader = makeReader(['data: {"name": "mcp_Tail"}']);

    const stream = createToolNameUnprefixStream(reader);
    const result = await collectStream(stream);

    expect(result).toContain('"name": "tail"');
  });

  it("preserves StructuredOutput PascalCase when unprefixing", async () => {
    const reader = makeReader(['data: {"name": "mcp_StructuredOutput"}\n\n']);

    const stream = createToolNameUnprefixStream(reader);
    const result = await collectStream(stream);

    expect(result).toContain('"name": "StructuredOutput"');
    expect(result).not.toContain("structuredOutput");
  });

  it("handles empty chunks without error", async () => {
    const reader = makeReader(["", 'data: {"name": "mcp_X"}\n\n', ""]);

    const stream = createToolNameUnprefixStream(reader);
    const result = await collectStream(stream);

    expect(result).toContain('"name": "x"');
  });

  it("passes through data without mcp_ prefix unchanged", async () => {
    const reader = makeReader(['data: {"name": "native_tool"}\n\n']);

    const stream = createToolNameUnprefixStream(reader);
    const result = await collectStream(stream);

    expect(result).toContain('"name": "native_tool"');
  });
});

describe("withUnprefixedToolNames", () => {
  it("restores tool names in a non-streaming JSON response", async () => {
    const response = new Response('{"content":[{"type":"tool_use","name":"mcp_Bash"}]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const restored = withUnprefixedToolNames(response);

    expect(await restored.text()).toBe('{"content":[{"type":"tool_use","name": "bash"}]}');
    expect(restored.headers.get("content-type")).toBe("application/json");
  });

  it("keeps status and headers of the original response", async () => {
    const response = new Response("unauthorized", { status: 401, statusText: "Unauthorized" });

    const restored = withUnprefixedToolNames(response);

    expect(restored.status).toBe(401);
    expect(restored.statusText).toBe("Unauthorized");
    expect(await restored.text()).toBe("unauthorized");
  });

  it("drops content-length because unprefixing changes the body length", () => {
    const body = '{"name":"mcp_Bash"}';
    const response = new Response(body, {
      headers: { "content-length": String(body.length) },
    });

    expect(withUnprefixedToolNames(response).headers.has("content-length")).toBe(false);
  });

  it("returns a bodiless response unchanged", () => {
    const response = new Response(null, { status: 204 });

    expect(withUnprefixedToolNames(response)).toBe(response);
  });
});

describe("prompt cache ttl", () => {
  const cached = { type: "ephemeral" };

  function cachedBody() {
    return JSON.stringify({
      model: "claude-sonnet-5-5",
      system: [{ type: "text", text: "Rules.", cache_control: cached }],
      tools: [{ name: "bash", cache_control: cached }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hi", cache_control: cached }] },
        { role: "assistant", content: "plain" },
      ],
    });
  }

  afterEach(() => {
    delete process.env.ANTHROPIC_PROMPT_CACHE_TTL;
  });

  it("upgrades every ephemeral breakpoint to the one hour ttl claude code uses", () => {
    const parsed = JSON.parse(transformRequestBody(cachedBody()).body);

    expect(parsed.system.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(parsed.tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("leaves non-ephemeral cache control untouched", () => {
    const body = JSON.stringify({
      model: "m",
      system: [{ type: "text", text: "Rules.", cache_control: { type: "persistent" } }],
      messages: [],
    });

    expect(JSON.parse(transformRequestBody(body).body).system.at(-1).cache_control).toEqual({
      type: "persistent",
    });
  });

  it("keeps an explicit ttl", () => {
    const body = JSON.stringify({
      model: "m",
      system: [{ type: "text", text: "Rules.", cache_control: { type: "ephemeral", ttl: "5m" } }],
      messages: [],
    });

    expect(JSON.parse(transformRequestBody(body).body).system.at(-1).cache_control.ttl).toBe("5m");
  });

  it("keeps every breakpoint at five minutes when the caller already chose 5m somewhere", () => {
    const body = JSON.stringify({
      model: "m",
      tools: [{ name: "bash", cache_control: { type: "ephemeral", ttl: "5m" } }],
      system: [{ type: "text", text: "Rules.", cache_control: { type: "ephemeral" } }],
      messages: [],
    });

    const parsed = JSON.parse(transformRequestBody(body).body);

    expect(parsed.system.at(-1).cache_control).toEqual({ type: "ephemeral" });
  });

  it("leaves breakpoints alone when ANTHROPIC_PROMPT_CACHE_TTL is 5m", () => {
    process.env.ANTHROPIC_PROMPT_CACHE_TTL = "5m";

    const parsed = JSON.parse(transformRequestBody(cachedBody()).body);

    expect(parsed.tools[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not add breakpoints", () => {
    const parsed = JSON.parse(transformRequestBody(cachedBody()).body);
    const marked = JSON.stringify(parsed).match(/cache_control/g) ?? [];

    expect(marked).toHaveLength(3);
  });
});

describe("request metadata", () => {
  const context = { sessionId: "session", deviceId: "device", accountUuid: "account" };

  it("adds the claude code user id when the account is known", () => {
    const parsed = JSON.parse(
      transformRequestBody(JSON.stringify({ model: "m", messages: [] }), context).body,
    );

    expect(JSON.parse(parsed.metadata.user_id)).toEqual({
      device_id: "device",
      account_uuid: "account",
      session_id: "session",
    });
  });

  it("keeps the caller's other metadata fields", () => {
    const body = JSON.stringify({ model: "m", messages: [], metadata: { tag: "kept" } });

    expect(JSON.parse(transformRequestBody(body, context).body).metadata.tag).toBe("kept");
  });

  it("keeps a user id chosen by the caller", () => {
    const body = JSON.stringify({ model: "m", messages: [], metadata: { user_id: "caller" } });

    expect(JSON.parse(transformRequestBody(body, context).body).metadata.user_id).toBe("caller");
  });

  it("omits metadata when the account is unknown", () => {
    const body = JSON.stringify({ model: "m", messages: [] });

    expect(
      JSON.parse(transformRequestBody(body, { ...context, accountUuid: null }).body).metadata,
    ).toBeUndefined();
  });
});

describe("withAccountMetadata", () => {
  const context = { sessionId: "session", deviceId: "device", accountUuid: "first" };

  function transformedBody() {
    return transformRequestBody(JSON.stringify({ model: "m", messages: [] }), context).body;
  }

  it("swaps the account uuid for a replay with another account", () => {
    const replayed = JSON.parse(withAccountMetadata(transformedBody(), "second"));

    expect(JSON.parse(replayed.metadata.user_id)).toEqual({
      device_id: "device",
      account_uuid: "second",
      session_id: "session",
    });
  });

  it("drops the user id when the other account is unknown", () => {
    expect(JSON.parse(withAccountMetadata(transformedBody(), null)).metadata).toEqual({});
  });

  it("keeps the caller's other metadata fields", () => {
    const body = transformRequestBody(
      JSON.stringify({ model: "m", messages: [], metadata: { tag: "kept" } }),
      context,
    ).body;

    expect(JSON.parse(withAccountMetadata(body, "second")).metadata.tag).toBe("kept");
    expect(JSON.parse(withAccountMetadata(body, null)).metadata).toEqual({ tag: "kept" });
  });

  it("leaves a user id chosen by the caller alone", () => {
    const body = JSON.stringify({ model: "m", metadata: { user_id: "caller" } });

    expect(JSON.parse(withAccountMetadata(body, "second")).metadata.user_id).toBe("caller");
  });

  it("returns unparseable bodies unchanged", () => {
    expect(withAccountMetadata("not json", "second")).toBe("not json");
  });
});
