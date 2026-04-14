import { TOOL_PREFIX } from "./constants.ts";
import { buildBillingHeaderValue } from "./cch.ts";
import { log } from "./logger.ts";

const OPENCODE_IDENTITY_PREFIX = "You are OpenCode";
const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const LEGACY_CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const PARAGRAPH_REMOVAL_ANCHORS = ["github.com/anomalyco/opencode", "opencode.ai/docs"];
const TEXT_REPLACEMENTS: { match: string; replacement: string }[] = [
  { match: "if OpenCode honestly", replacement: "if the assistant honestly" },
];

interface ParsedBody {
  body: string;
  modelId: string | null;
}

type JsonRecord = Record<string, unknown>;
type SystemBlock = { type: "text"; text: string; [key: string]: unknown };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Prefix a tool name with TOOL_PREFIX and uppercase the first character.
 * Claude Code uses PascalCase tool names (e.g. mcp_Bash, mcp_Read);
 * lowercase names (mcp_bash, mcp_read) are flagged as non-Claude-Code clients.
 */
function prefixName(name: string): string {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function sanitizeSystemText(text: string): string {
  const paragraphs = text.split(/\n\n+/);
  const filtered = paragraphs.filter((paragraph) => {
    const trimmed = paragraph.trim();
    if (trimmed.startsWith(OPENCODE_IDENTITY_PREFIX)) return false;
    return !PARAGRAPH_REMOVAL_ANCHORS.some((anchor) => trimmed.includes(anchor));
  });

  let result = filtered.join("\n\n").replace(/\n{3,}/g, "\n\n");

  for (const rule of TEXT_REPLACEMENTS) {
    result = result.replace(rule.match, rule.replacement);
  }

  return result.trim();
}

function toTextSystemBlock(item: unknown): SystemBlock | null {
  if (typeof item === "string") {
    const sanitized = sanitizeSystemText(item);
    if (!sanitized) return null;
    return { type: "text", text: sanitized };
  }

  if (!isRecord(item)) return null;

  const hasSupportedType = item.type === "text" || item.type === undefined;
  if (!hasSupportedType || typeof item.text !== "string") {
    return null;
  }

  const sanitized = sanitizeSystemText(item.text);
  if (!sanitized) return null;

  return {
    ...item,
    type: "text",
    text: sanitized,
  };
}

function normalizeSystem(system: unknown): SystemBlock[] {
  const identityBlock: SystemBlock = {
    type: "text",
    text: CLAUDE_CODE_IDENTITY,
  };

  if (system == null) {
    return [identityBlock];
  }

  const blocks = Array.isArray(system)
    ? system.map(toTextSystemBlock).filter((item): item is SystemBlock => item !== null)
    : [toTextSystemBlock(system)].filter((item): item is SystemBlock => item !== null);

  if (blocks.length === 0) {
    return [identityBlock];
  }

  const firstText = blocks[0].text;
  if (firstText === CLAUDE_CODE_IDENTITY) {
    return blocks;
  }

  if (firstText === LEGACY_CLAUDE_CODE_IDENTITY) {
    blocks[0] = {
      ...blocks[0],
      type: "text",
      text: CLAUDE_CODE_IDENTITY,
    };
    return blocks;
  }

  return [identityBlock, ...blocks];
}

function prefixToolNames(parsed: JsonRecord): void {
  if (Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.map((tool) => {
      if (!isRecord(tool) || typeof tool.name !== "string") {
        return tool;
      }
      return { ...tool, name: prefixName(tool.name) };
    });
  }

  if (Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map((message) => {
      if (!isRecord(message) || !Array.isArray(message.content)) {
        return message;
      }
      return {
        ...message,
        content: message.content.map((block) => {
          if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
            return { ...block, name: prefixName(block.name) };
          }
          return block;
        }),
      };
    });
  }
}

export function transformRequestBody(rawBody: string): ParsedBody {
  try {
    const parsed = JSON.parse(rawBody) as JsonRecord;
    const modelId = typeof parsed.model === "string" ? parsed.model : null;

    // Sanitize system and prepend Claude Code identity (no relocation)
    parsed.system = normalizeSystem(parsed.system);

    // Prepend billing header as system[0] when user messages are present
    const hasUserMessage =
      Array.isArray(parsed.messages) &&
      parsed.messages.some((m) => isRecord(m) && m.role === "user");
    if (hasUserMessage) {
      const billingHeader = buildBillingHeaderValue(
        parsed.messages as {
          role?: string;
          content?: string | Array<{ type?: string; text?: string }>;
        }[],
      );
      if (Array.isArray(parsed.system)) {
        parsed.system.unshift({ type: "text", text: billingHeader });
      }
    }

    // Prefix tool names (PascalCase)
    prefixToolNames(parsed);

    return { body: JSON.stringify(parsed), modelId };
  } catch {
    log.warn("Failed to parse request body for transformation");
    return { body: rawBody, modelId: null };
  }
}

const TOOL_NAME_RE = /"name"\s*:\s*"mcp_([^"]+)"/g;

export function createToolNameUnprefixStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          const remaining = decoder.decode();
          buffer += remaining;
          if (buffer) {
            const cleaned = buffer.replace(
              TOOL_NAME_RE,
              (_m, cap: string) => `"name": "${cap.charAt(0).toLowerCase()}${cap.slice(1)}"`,
            );
            controller.enqueue(encoder.encode(cleaned));
          }
          controller.close();
          return;
        }

        const chunk = decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        buffer += chunk;

        const lastBoundary = buffer.lastIndexOf("\n\n");
        if (lastBoundary === -1) continue;

        const complete = buffer.slice(0, lastBoundary + 2);
        buffer = buffer.slice(lastBoundary + 2);

        const cleaned = complete.replace(
          TOOL_NAME_RE,
          (_m, cap: string) => `"name": "${cap.charAt(0).toLowerCase()}${cap.slice(1)}"`,
        );
        controller.enqueue(encoder.encode(cleaned));
        return;
      }
    },
  });
}
