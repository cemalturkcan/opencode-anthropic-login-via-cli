import { describe, expect, it, mock } from "bun:test";
import { transformRequestBody, createToolNameUnprefixStream } from "../src/transforms.ts";

const INTRO_MOCK = {
  version: "2.1.84",
  userAgent: "claude-cli/2.1.84",
  betaHeaders: [],
  scopes: "",
};
mock.module("../src/introspection.ts", () => ({
  getIntro: () => INTRO_MOCK,
  startIntro: () => {},
  awaitIntro: async () => INTRO_MOCK,
}));

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

    // system[0] = billing header, system[1] = identity, system[2..] = sanitized content
    expect(parsed.system[0].text).toContain("x-anthropic-billing-header");
    expect(parsed.system[1].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(parsed.system[2].text).toBe("Follow team guardrails.");
    expect(parsed.system[3].text).toBe("Prefer deterministic output.");
    // User message untouched
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

    // No billing header (no user message), identity + instruction in system
    expect(parsed.system[0].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(parsed.system[1].text).toBe("Carry this instruction forward.");
    // Messages unchanged
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

    // Billing header + Claude Code identity (OpenCode identity was removed)
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

    // The variant should be removed since it starts with "You are OpenCode"
    expect(parsed.system[0].text).toContain("x-anthropic-billing-header");
    expect(parsed.system[1].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(parsed.system.length).toBe(2);
  });

  it("rewrites the environment intro fingerprint during sanitization", () => {
    // Anthropic's classifier rejects OpenCode's default system prompt because
    // of a verbatim env-block intro sentence. The rewrite preserves meaning
    // while dodging the match.
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
    // User message untouched
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

    // Billing header + identity + "Supported instruction." only
    expect(parsed.system[0].text).toContain("x-anthropic-billing-header");
    expect(parsed.system[1].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(parsed.system[2].text).toBe("Supported instruction.");
    expect(parsed.system.length).toBe(3);
    // User message untouched
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
