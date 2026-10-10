import { buildBillingHeaderValue, type Message } from "./billingHeader.ts";
import { toolPrefix } from "./constants.ts";
import { isJsonObject, isJsonString, parseJson, type JsonObject, type JsonValue } from "./json.ts";
import { log } from "./logger.ts";

const openCodeIdentityPrefix = "You are OpenCode";
const claudeCodeIdentity = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const legacyClaudeCodeIdentity = "You are Claude Code, Anthropic's official CLI for Claude.";

const paragraphRemovalAnchors = ["github.com/anomalyco/opencode", "opencode.ai/docs"];
const environmentIntroFingerprint =
  "Here is some useful information about the environment you are running in:";
const systemTextReplacements = new Map([
  ["if OpenCode honestly", "if the assistant honestly"],
  [environmentIntroFingerprint, "Environment context you are running in:"],
]);
const preserveCaseToolNames = new Set(["StructuredOutput"]);
const prefixedToolNamePattern = /"name"\s*:\s*"mcp_([^"]+)"/g;

type TransformedBody = {
  body: string;
  modelId: string | null;
};

export type BodyContext = {
  sessionId: string;
  deviceId: string;
  accountUuid: string | null;
};

type SystemBlock = JsonObject & { type: "text"; text: string };

function toClaudeCodeToolName(name: string): string {
  return `${toolPrefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function fromClaudeCodeToolName(name: string): string {
  if (preserveCaseToolNames.has(name)) return name;
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}

function sanitizeSystemText(text: string): string {
  const kept = text.split(/\n\n+/).filter((paragraph) => {
    const trimmed = paragraph.trim();
    if (trimmed.startsWith(openCodeIdentityPrefix)) return false;
    return !paragraphRemovalAnchors.some((anchor) => trimmed.includes(anchor));
  });

  let result = kept.join("\n\n").replace(/\n{3,}/g, "\n\n");
  for (const [match, replacement] of systemTextReplacements) {
    result = result.replace(match, replacement);
  }
  return result.trim();
}

function toTextSystemBlock(item: JsonValue): SystemBlock | null {
  if (isJsonString(item)) {
    const text = sanitizeSystemText(item);
    return text ? { type: "text", text } : null;
  }

  if (!isJsonObject(item) || !isJsonString(item.text)) return null;
  if (item.type !== "text" && item.type !== undefined) return null;

  const text = sanitizeSystemText(item.text);
  return text ? { ...item, type: "text", text } : null;
}

function normalizeSystem(system: JsonValue | undefined): SystemBlock[] {
  const identityBlock: SystemBlock = { type: "text", text: claudeCodeIdentity };
  if (system === undefined || system === null) return [identityBlock];

  const items = Array.isArray(system) ? system : [system];
  const blocks = items.map(toTextSystemBlock).filter((block) => block !== null);
  if (blocks.length === 0) return [identityBlock];

  const firstText = blocks[0].text;
  if (firstText === claudeCodeIdentity) return blocks;
  if (firstText === legacyClaudeCodeIdentity) {
    blocks[0] = { ...blocks[0], text: claudeCodeIdentity };
    return blocks;
  }
  return [identityBlock, ...blocks];
}

function prefixNamedRecord(value: JsonValue): JsonValue {
  if (!isJsonObject(value) || !isJsonString(value.name)) return value;
  return { ...value, name: toClaudeCodeToolName(value.name) };
}

function prefixToolUseBlocks(message: JsonValue): JsonValue {
  if (!isJsonObject(message) || !Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((block) =>
      isJsonObject(block) && block.type === "tool_use" ? prefixNamedRecord(block) : block,
    ),
  };
}

function prefixToolNames(body: JsonObject): void {
  if (Array.isArray(body.tools)) body.tools = body.tools.map(prefixNamedRecord);
  if (Array.isArray(body.messages)) body.messages = body.messages.map(prefixToolUseBlocks);
  if (isJsonObject(body.tool_choice) && body.tool_choice.type === "tool") {
    body.tool_choice = prefixNamedRecord(body.tool_choice);
  }
}

function promptCacheTtl(): string | null {
  return process.env.ANTHROPIC_PROMPT_CACHE_TTL === "5m" ? null : "1h";
}

function withCacheTtl(block: JsonValue, ttl: string): JsonValue {
  if (!isJsonObject(block) || !isJsonObject(block.cache_control)) return block;
  const { cache_control: cacheControl } = block;
  if (cacheControl.type !== "ephemeral" || cacheControl.ttl !== undefined) return block;
  return { ...block, cache_control: { ...cacheControl, ttl } };
}

function withContentCacheTtl(message: JsonValue, ttl: string): JsonValue {
  if (!isJsonObject(message) || !Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map((block) => withCacheTtl(block, ttl)) };
}

function hasShortTtlBreakpoint(body: JsonObject): boolean {
  return /"cache_control"\s*:\s*\{[^}]*"ttl"\s*:\s*"5m"/.test(JSON.stringify(body));
}

function applyCacheTtl(body: JsonObject): void {
  const ttl = promptCacheTtl();
  if (!ttl || hasShortTtlBreakpoint(body)) return;
  if (Array.isArray(body.system))
    body.system = body.system.map((block) => withCacheTtl(block, ttl));
  if (Array.isArray(body.tools)) body.tools = body.tools.map((tool) => withCacheTtl(tool, ttl));
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => withContentCacheTtl(message, ttl));
  }
}

function applyMetadata(body: JsonObject, context: BodyContext | undefined): void {
  if (!context?.accountUuid) return;
  const metadata = isJsonObject(body.metadata) ? body.metadata : {};
  if (metadata.user_id !== undefined) return;

  const userId = JSON.stringify({
    device_id: context.deviceId,
    account_uuid: context.accountUuid,
    session_id: context.sessionId,
  });
  body.metadata = { ...metadata, user_id: userId };
}

function claudeCodeUserId(value: JsonValue | undefined): JsonObject | null {
  if (!isJsonString(value)) return null;
  const parsed = parseJson(value);
  if (!isJsonObject(parsed)) return null;
  return isJsonString(parsed.device_id) && isJsonString(parsed.session_id) ? parsed : null;
}

export function withAccountMetadata(rawBody: string, accountUuid: string | null): string {
  const body = parseJson(rawBody);
  if (!isJsonObject(body) || !isJsonObject(body.metadata)) return rawBody;
  const userId = claudeCodeUserId(body.metadata.user_id);
  if (!userId) return rawBody;

  const { user_id: _previous, ...metadata } = body.metadata;
  body.metadata = accountUuid
    ? { ...metadata, user_id: JSON.stringify({ ...userId, account_uuid: accountUuid }) }
    : metadata;
  return JSON.stringify(body);
}

function toMessage(value: JsonObject): Message {
  const { role, content } = value;
  if (isJsonString(content)) return { role: isJsonString(role) ? role : undefined, content };
  const blocks = Array.isArray(content) ? content.filter(isJsonObject) : [];
  return {
    role: isJsonString(role) ? role : undefined,
    content: blocks.map((block) => ({
      type: isJsonString(block.type) ? block.type : undefined,
      text: isJsonString(block.text) ? block.text : undefined,
    })),
  };
}

function conversationWithUser(body: JsonObject): Message[] | null {
  if (!Array.isArray(body.messages)) return null;
  const messages = body.messages.filter(isJsonObject).map(toMessage);
  return messages.some((message) => message.role === "user") ? messages : null;
}

export function transformRequestBody(rawBody: string, context?: BodyContext): TransformedBody {
  const body = parseJson(rawBody);
  if (!isJsonObject(body)) {
    log.warn("failed to parse request body for transformation");
    return { body: rawBody, modelId: null };
  }

  const system = normalizeSystem(body.system);
  const messages = conversationWithUser(body);
  body.system = messages
    ? [{ type: "text", text: buildBillingHeaderValue(messages) }, ...system]
    : system;
  prefixToolNames(body);
  applyCacheTtl(body);
  applyMetadata(body, context);

  return { body: JSON.stringify(body), modelId: isJsonString(body.model) ? body.model : null };
}

function unprefixToolNames(text: string): string {
  return text.replace(
    prefixedToolNamePattern,
    (_match, name: string) => `"name": "${fromClaudeCodeToolName(name)}"`,
  );
}

function unprefixStreamEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: { buffer: string; decoder: TextDecoder; encoder: TextEncoder },
): Promise<void> {
  return reader.read().then(({ done, value }) => {
    if (done) {
      state.buffer += state.decoder.decode();
      if (state.buffer) controller.enqueue(state.encoder.encode(unprefixToolNames(state.buffer)));
      controller.close();
      return;
    }

    state.buffer += state.decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    const lastBoundary = state.buffer.lastIndexOf("\n\n");
    if (lastBoundary === -1) return unprefixStreamEvents(reader, controller, state);

    const complete = state.buffer.slice(0, lastBoundary + 2);
    state.buffer = state.buffer.slice(lastBoundary + 2);
    controller.enqueue(state.encoder.encode(unprefixToolNames(complete)));
  });
}

export function createToolNameUnprefixStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  const state = { buffer: "", decoder: new TextDecoder(), encoder: new TextEncoder() };
  return new ReadableStream({
    pull: (controller) => unprefixStreamEvents(reader, controller, state),
  });
}

export function withUnprefixedToolNames(response: Response): Response {
  if (!response.body) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(createToolNameUnprefixStream(response.body.getReader()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
