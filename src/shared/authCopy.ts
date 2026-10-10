import { getInstalledCliVersion, getLatestCliVersion } from "./introspection.ts";

export const claudeSiteUrl = "https://claude.ai";
export const claudeCodeDocsUrl = "https://docs.anthropic.com/en/docs/build-with-claude/claude-code";
export const cliMethodLabel = "Claude Code (auto)";
export const browserMethodLabel = "Claude Pro/Max (browser)";
export const apiKeyMethodLabel = "API Key (manual)";
export const browserInstructions =
  "Open the link above to authenticate with your Claude account. After authorizing, you will receive a code. Paste it below.";
export const cliMissingInstructions =
  "Claude CLI not found. Install it with `npm install -g @anthropic-ai/claude-code`, run `claude` to log in, or use the browser method.";

export function ccsMethodLabel(instanceName: string): string {
  return `CCS (${instanceName})`;
}

export function ccsInstructions(instanceName: string): string {
  return `Detecting credentials for CCS instance "${instanceName}"...`;
}

export function cliDetectionInstructions(): string {
  const latest = getLatestCliVersion();
  const outdated = latest
    ? `\n\nClaude CLI is outdated (installed ${getInstalledCliVersion()}, latest ${latest}). Run: npm install -g @anthropic-ai/claude-code`
    : "";
  return `Detecting Claude Code credentials...${outdated}`;
}
