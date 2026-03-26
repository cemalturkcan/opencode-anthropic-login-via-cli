import { TOOL_PREFIX } from "./constants.ts";
import { log } from "./logger.ts";

interface ParsedBody {
  body: string;
  modelId: string | null;
}

export function transformRequestBody(rawBody: string): ParsedBody {
  try {
    const parsed = JSON.parse(rawBody);
    const modelId: string | null = parsed.model ?? null;

    if (parsed.system && Array.isArray(parsed.system)) {
      parsed.system = parsed.system.map((item: { type?: string; text?: string }) => {
        if (item.type === "text" && item.text) {
          return {
            ...item,
            text: item.text.replace(/OpenCode/g, "Claude Code").replace(/opencode/gi, "Claude"),
          };
        }
        return item;
      });
    }

    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((t: { name?: string }) => ({
        ...t,
        name: t.name ? `${TOOL_PREFIX}${t.name}` : t.name,
      }));
    }

    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map(
        (msg: { content?: Array<{ type?: string; name?: string }> }) => {
          if (msg.content && Array.isArray(msg.content)) {
            msg.content = msg.content.map((block) => {
              if (block.type === "tool_use" && block.name) {
                return { ...block, name: `${TOOL_PREFIX}${block.name}` };
              }
              return block;
            });
          }
          return msg;
        },
      );
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
      if (lastBoundary === -1) return;

      const complete = buffer.slice(0, lastBoundary + 2);
      buffer = buffer.slice(lastBoundary + 2);

      const cleaned = complete.replace(TOOL_NAME_RE, '"name": "$1"');
      controller.enqueue(encoder.encode(cleaned));
    },
  });
}
