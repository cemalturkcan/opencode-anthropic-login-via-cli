import type { CliIdentity } from "./constants.ts";
import { getBetaFlags, getBetasForModel } from "./modelConfig.ts";

const openCodeOnlyHeaders = [
  "x-opencode-session-id",
  "x-opencode-session",
  "x-opencode-client",
  "x-opencode-project",
  "x-session-id",
  "x-session-affinity",
  "traceparent",
  "b3",
];

const stainlessOs = new Map([
  ["linux", "Linux"],
  ["darwin", "MacOS"],
  ["win32", "Windows"],
]);

export type OAuthRequestIdentity = {
  access: string;
  sessionId: string;
  cli: CliIdentity;
};

export function claudeCodeHeaders(): Map<string, string> {
  return new Map([
    ["anthropic-dangerous-direct-browser-access", "true"],
    ["x-stainless-arch", process.arch],
    ["x-stainless-lang", "js"],
    ["x-stainless-os", stainlessOs.get(process.platform) ?? `Other:${process.platform}`],
    ["x-stainless-package-version", "0.128.0"],
    ["x-stainless-retry-count", "0"],
    ["x-stainless-runtime", "node"],
    ["x-stainless-runtime-version", "v26.3.0"],
    ["x-stainless-timeout", "600"],
  ]);
}

export function hasJsonContentType(headers: Headers): boolean {
  return headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;
}

export function mergeBetas(modelId: string | null, incoming: string | null): string {
  const defaults = getBetaFlags();
  const modelBetas = modelId ? getBetasForModel(modelId, defaults) : defaults;
  const incomingBetas = (incoming ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);
  return [...new Set([...modelBetas, ...incomingBetas])].join(",");
}

export function applyOAuthHeaders(
  headers: Headers,
  modelId: string | null,
  identity: OAuthRequestIdentity,
): void {
  for (const [name, value] of claudeCodeHeaders()) headers.set(name, value);
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  headers.set("authorization", `Bearer ${identity.access}`);
  headers.set("anthropic-beta", mergeBetas(modelId, headers.get("anthropic-beta")));
  headers.set("user-agent", identity.cli.userAgent);
  headers.set("x-app", "cli");
  headers.set("x-claude-code-session-id", identity.sessionId);
  headers.delete("x-api-key");
  for (const name of openCodeOnlyHeaders) headers.delete(name);
}
