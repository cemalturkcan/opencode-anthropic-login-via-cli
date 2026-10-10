import { platform } from "node:os";

export const oauthClientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const authorizeUrl = "https://claude.com/cai/oauth/authorize";
export const tokenUrl = "https://platform.claude.com/v1/oauth/token";
export const redirectUri = "https://platform.claude.com/oauth/code/callback";
export const toolPrefix = "mcp_";

export const defaultCliVersion = "2.1.84";
export const defaultScopes =
  "org:create_api_key user:file_upload user:inference user:mcp_servers user:profile user:sessions:claude_code";
export const refreshBufferMs = 5 * 60 * 1000;
export const claudeCodeEntrypoint = "sdk-cli";

export const isWindows = platform() === "win32";
export const isMac = platform() === "darwin";
export const claudeCommand = isWindows ? "claude.exe" : "claude";

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
