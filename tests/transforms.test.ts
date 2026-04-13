import { describe, expect, it } from "bun:test";
import { transformRequestBody, createToolNameUnprefixStream } from "../src/transforms.ts";

const OPENCODE_IDENTITY = "You are OpenCode, the best coding agent on the planet.";
const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const OPENCODE_RUNTIME_CONTEXT =
  "Runtime context: You are running inside OpenCode, not the Claude Code CLI. " +
  "Config is opencode.json (not claude.json), .opencode/ holds agents and plugins. " +
  "Refer to OpenCode's own capabilities and tools, not Claude Code's.";

describe("transformRequestBody", () => {
  it("prefixes tool names with mcp_", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      tools: [{ name: "bash" }, { name: "read_file" }],
      messages: [],
    });

    const { body, modelId } = transformRequestBody(input);
    const parsed = JSON.parse(body);

    expect(parsed.tools[0].name).toBe("mcp_bash");
    expect(parsed.tools[1].name).toBe("mcp_read_file");
    expect(modelId).toBe("claude-sonnet-4-20250514");
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

    expect(parsed.messages[0].content[0].name).toBe("mcp_bash");
  });

  it("relocates supported system text into the first user message", () => {
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

    expect(parsed.system).toEqual([{ type: "text", text: CLAUDE_CODE_IDENTITY }]);
    expect(parsed.messages[0].content).toBe(
      `${OPENCODE_RUNTIME_CONTEXT}\n\nFollow team guardrails.\n\nPrefer deterministic output.\n\nBuild the handler.`,
    );
  });

  it("synthesizes a user message when relocation has no user target", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [{ type: "text", text: "Carry this instruction forward." }],
      messages: [{ role: "assistant", content: "Ready." }],
    });

    const { body } = transformRequestBody(input);
    const parsed = JSON.parse(body);

    expect(parsed.system).toEqual([{ type: "text", text: CLAUDE_CODE_IDENTITY }]);
    expect(parsed.messages[0]).toEqual({
      role: "user",
      content: `${OPENCODE_RUNTIME_CONTEXT}\n\nCarry this instruction forward.`,
    });
    expect(parsed.messages[1].role).toBe("assistant");
  });

  it("does not inject runtime context when no system text was relocated", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [{ type: "text", text: OPENCODE_IDENTITY }],
      messages: [{ role: "user", content: "Hello" }],
    });

    const { body } = transformRequestBody(input);
    const parsed = JSON.parse(body);

    expect(parsed.system).toEqual([{ type: "text", text: CLAUDE_CODE_IDENTITY }]);
    expect(parsed.messages[0].content).toBe("Hello");
  });

  it("does not stringify unsupported system entries into prompt text", () => {
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
    const firstUserText = parsed.messages[0].content as string;

    expect(parsed.system).toEqual([{ type: "text", text: CLAUDE_CODE_IDENTITY }]);
    expect(firstUserText).toBe(
      `${OPENCODE_RUNTIME_CONTEXT}\n\nSupported instruction.\n\nHandle request.`,
    );
    expect(firstUserText).not.toContain("[object Object]");
    expect(firstUserText).not.toContain("Should not leak.");
  });

  it("does not duplicate runtime context on repeated transformation", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [{ type: "text", text: "Carry this forward." }],
      messages: [{ role: "user", content: "First request." }],
    });

    const firstPass = transformRequestBody(input).body;
    const secondPass = transformRequestBody(firstPass).body;
    const parsed = JSON.parse(secondPass);

    const userContent = parsed.messages[0].content as string;
    const occurrences = userContent.split(OPENCODE_RUNTIME_CONTEXT).length - 1;
    expect(occurrences).toBe(1);
  });

  it("keeps runtime context out of the system array", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [{ type: "text", text: `${OPENCODE_IDENTITY}\n\nSome instructions.` }],
      messages: [{ role: "user", content: "Test." }],
    });

    const { body } = transformRequestBody(input);
    const parsed = JSON.parse(body);

    expect(parsed.system.length).toBe(1);
    expect(parsed.system[0].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(parsed.system[0].text).not.toContain("Runtime context");
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

describe("createToolNameUnprefixStream", () => {
  function makeReader(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i]));
          i++;
        } else {
          controller.close();
        }
      },
    });
    return stream.getReader();
  }

  async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  }

  it("strips mcp_ prefix from tool names in complete SSE events", async () => {
    const reader = makeReader(['data: {"name": "mcp_bash", "id": "1"}\n\n']);

    const stream = createToolNameUnprefixStream(reader);
    const result = await collectStream(stream);

    expect(result).toBe('data: {"name": "bash", "id": "1"}\n\n');
  });

  it("buffers across chunk boundaries until \\n\\n", async () => {
    const reader = makeReader(['data: {"name": "mcp_', 'bash", "id": "1"}\n\n']);

    const stream = createToolNameUnprefixStream(reader);
    const result = await collectStream(stream);

    expect(result).toContain('"name": "bash"');
  });

  it("handles \\r\\n\\r\\n boundaries via normalization", async () => {
    const reader = makeReader(['data: {"name": "mcp_read_file"}\r\n\r\n']);

    const stream = createToolNameUnprefixStream(reader);
    const result = await collectStream(stream);

    expect(result).toContain('"name": "read_file"');
  });

  it("handles multiple events in a single chunk", async () => {
    const reader = makeReader(['data: {"name": "mcp_a"}\n\ndata: {"name": "mcp_b"}\n\n']);

    const stream = createToolNameUnprefixStream(reader);
    const result = await collectStream(stream);

    expect(result).toContain('"name": "a"');
    expect(result).toContain('"name": "b"');
  });

  it("flushes remaining buffer on stream end", async () => {
    const reader = makeReader(['data: {"name": "mcp_tail"}']);

    const stream = createToolNameUnprefixStream(reader);
    const result = await collectStream(stream);

    expect(result).toContain('"name": "tail"');
  });

  it("handles empty chunks without error", async () => {
    const reader = makeReader(["", 'data: {"name": "mcp_x"}\n\n', ""]);

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
