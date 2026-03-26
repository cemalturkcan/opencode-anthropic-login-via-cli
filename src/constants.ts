import { platform } from "node:os";

// ── OAuth Configuration ──────────────────────────────────────────────────────

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const TOOL_PREFIX = "mcp_";

// ── Defaults (used when binary introspection fails or hasn't completed) ─────

export const DEFAULT_VERSION = "2.1.80";
export const DEFAULT_SCOPES =
  "org:create_api_key user:file_upload user:inference user:mcp_servers user:profile user:sessions:claude_code";
export const DEFAULT_BETA_HEADERS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "oauth-2025-04-20",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
];

export const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ── Platform ─────────────────────────────────────────────────────────────────

export const IS_WIN = platform() === "win32";
export const CLAUDE_CMD = IS_WIN ? "claude.exe" : "claude";

// ── Types ────────────────────────────────────────────────────────────────────

export type OAuthTokens = {
  access: string;
  refresh: string;
  expires: number;
};

export type IntrospectionResult = {
  version: string;
  userAgent: string;
  betaHeaders: string[];
  scopes: string;
};
