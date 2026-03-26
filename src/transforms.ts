import { TOOL_PREFIX } from "./constants.ts";
import { log } from "./logger.ts";

// ── Body Transformation ──────────────────────────────────────────────────────

interface ParsedBody {
  body: string;
  modelId: string | null;
}

/**
 * Transform request body:
 * - Sanitize system prompt (OpenCode -> Claude Code)
 * - Prefix tool names with mcp_
 * - Extract model ID for beta selection
 */
export function transformRequestBody(rawBody: string): ParsedBody {
  try {
    const parsed = JSON.parse(rawBody);
    const modelId: string | null = parsed.model ?? null;

    // Sanitize system prompt: OpenCode -> Claude Code
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

    // Prefix tool names with mcp_
    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((t: { name?: string }) => ({
        ...t,
        name: t.name ? `${TOOL_PREFIX}${t.name}` : t.name,
      }));
    }

    // Prefix tool_use blocks in messages
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

// ── SSE Stream Tool Name Un-Prefixing ────────────────────────────────────────
// Buffers SSE events at \n\n boundaries for reliable regex replacement.
// Prevents mid-chunk splits from breaking tool name detection.

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
        // Flush remaining buffer
        if (buffer) {
          const cleaned = buffer.replace(TOOL_NAME_RE, '"name": "$1"');
          controller.enqueue(encoder.encode(cleaned));
        }
        controller.close();
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events (delimited by \n\n)
      const lastBoundary = buffer.lastIndexOf("\n\n");
      if (lastBoundary === -1) return; // No complete event yet, keep buffering

      const complete = buffer.slice(0, lastBoundary + 2);
      buffer = buffer.slice(lastBoundary + 2);

      const cleaned = complete.replace(TOOL_NAME_RE, '"name": "$1"');
      controller.enqueue(encoder.encode(cleaned));
    },
  });
}
