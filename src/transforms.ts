import { TOOL_PREFIX } from "./constants.ts";
import { log } from "./logger.ts";

const OPENCODE_IDENTITY = "You are OpenCode, the best coding agent on the planet.";
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

function sanitizeSystemText(text: string): string {
  if (!text.includes(OPENCODE_IDENTITY)) return text.trim();

  const paragraphs = text.split(/\n\n+/);
  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.trim() === OPENCODE_IDENTITY) return false;
    return !PARAGRAPH_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor));
  });

  let result = filtered.join("\n\n");
  result = result.replace(OPENCODE_IDENTITY, "").replace(/\n{3,}/g, "\n\n");

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

function prependSystemTextToFirstUserMessage(messages: unknown, text: string): unknown[] {
  const normalizedMessages = Array.isArray(messages) ? [...messages] : [];

  const firstUserIndex = normalizedMessages.findIndex(
    (message) => isRecord(message) && message.role === "user",
  );
  if (firstUserIndex === -1) {
    return [{ role: "user", content: text }, ...normalizedMessages];
  }

  const userMessage = normalizedMessages[firstUserIndex];
  if (!isRecord(userMessage)) {
    return normalizedMessages;
  }
  const existingContent = userMessage.content;

  if (typeof existingContent === "string") {
    userMessage.content = `${text}\n\n${existingContent}`;
    return normalizedMessages;
  }

  if (Array.isArray(existingContent)) {
    userMessage.content = [{ type: "text", text }, ...existingContent];
    return normalizedMessages;
  }

  if (existingContent == null) {
    userMessage.content = text;
    return normalizedMessages;
  }

  userMessage.content = [{ type: "text", text }, existingContent];
  return normalizedMessages;
}

function relocateSystemText(
  system: unknown,
  messages: unknown,
): {
  system: SystemBlock[];
  messages: unknown;
} {
  const normalizedSystem = normalizeSystem(system);
  if (normalizedSystem.length <= 1) {
    return { system: normalizedSystem, messages };
  }

  const movedTexts = normalizedSystem
    .slice(1)
    .map((block) => block.text.trim())
    .filter(
      (text) =>
        text.length > 0 && text !== CLAUDE_CODE_IDENTITY && text !== LEGACY_CLAUDE_CODE_IDENTITY,
    );

  if (movedTexts.length === 0) {
    return {
      system: [normalizedSystem[0]],
      messages,
    };
  }

  const joined = movedTexts.join("\n\n");
  return {
    system: [normalizedSystem[0]],
    messages: prependSystemTextToFirstUserMessage(messages, joined),
  };
}

export function transformRequestBody(rawBody: string): ParsedBody {
  try {
    const parsed = JSON.parse(rawBody) as JsonRecord;
    const modelId = typeof parsed.model === "string" ? parsed.model : null;

    const relocated = relocateSystemText(parsed.system, parsed.messages);
    parsed.system = relocated.system;
    parsed.messages = relocated.messages;

    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => {
        if (!isRecord(tool) || typeof tool.name !== "string") {
          return tool;
        }

        return {
          ...tool,
          name: `${TOOL_PREFIX}${tool.name}`,
        };
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
              return {
                ...block,
                name: `${TOOL_PREFIX}${block.name}`,
              };
            }

            return block;
          }),
        };
      });
    }

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
            const cleaned = buffer.replace(TOOL_NAME_RE, '"name": "$1"');
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

        const cleaned = complete.replace(TOOL_NAME_RE, '"name": "$1"');
        controller.enqueue(encoder.encode(cleaned));
        return;
      }
    },
  });
}
