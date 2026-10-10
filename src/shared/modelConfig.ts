import { claudeCodeEntrypoint } from "./constants.ts";

export const claudeCodeBetas = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "per-turn-control-2026-07-01",
  "mid-conversation-tool-changes-2026-07-01",
  "inline-tools-2026-09-15",
  "advisor-tool-2026-03-01",
  "effort-2025-11-24",
  "extended-cache-ttl-2025-04-11",
];

export const longContextBeta = "context-1m-2025-08-07";

const nativeLongContextModel = /(?:^|-)(?:opus-4-[78]|(?:haiku|sonnet|opus|fable|mythos)-5)(?:-|$)/;

export function getCliVersion(detected: string): string {
  return process.env.ANTHROPIC_CLI_VERSION || detected;
}

export function getUserAgent(version: string): string {
  return (
    process.env.ANTHROPIC_USER_AGENT || `claude-cli/${version} (external, ${claudeCodeEntrypoint})`
  );
}

export function getBetaFlags(): string[] {
  const custom = process.env.ANTHROPIC_BETA_FLAGS;
  if (!custom) return claudeCodeBetas;
  return custom
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);
}

export function isNativeLongContextModel(modelId: string): boolean {
  return nativeLongContextModel.test(modelId);
}

function isLongContextEnabled(): boolean {
  const setting = process.env.ANTHROPIC_ENABLE_1M_CONTEXT;
  return setting === "1" || setting === "true";
}

export function getBetasForModel(modelId: string, defaults: string[]): string[] {
  const wantsLongContext = isLongContextEnabled() && !isNativeLongContextModel(modelId);
  if (!wantsLongContext || defaults.includes(longContextBeta)) return defaults;
  return [...defaults, longContextBeta];
}
