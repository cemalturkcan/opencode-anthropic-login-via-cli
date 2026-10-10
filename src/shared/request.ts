import type { IntrospectionResult } from "./constants.ts";
import { getBetaFlags, getBetasForModel } from "./modelConfig.ts";

export function hasJsonContentType(headers: Headers): boolean {
  return headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;
}

export function mergeBetas(
  modelId: string | null,
  introBetas: string[],
  incoming: string | null,
): string {
  const defaults = getBetaFlags(introBetas);
  const modelBetas = modelId ? getBetasForModel(modelId, defaults) : defaults;
  const incomingBetas = (incoming ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);
  return [...new Set([...modelBetas, ...incomingBetas])].join(",");
}

export function applyOAuthHeaders(
  headers: Headers,
  access: string,
  modelId: string | null,
  intro: IntrospectionResult,
): void {
  headers.set("authorization", `Bearer ${access}`);
  headers.set(
    "anthropic-beta",
    mergeBetas(modelId, intro.betaHeaders, headers.get("anthropic-beta")),
  );
  headers.set("user-agent", intro.userAgent);
  headers.set("x-app", "cli");
  headers.delete("x-api-key");
}
