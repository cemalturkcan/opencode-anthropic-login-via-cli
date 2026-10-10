export const baseBetas = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "oauth-2025-04-20",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
];

export const longContextBetas = ["context-1m-2025-08-07"];

type BetaOverride = { add?: string[]; remove?: string[] };

const modelBetaOverrides = new Map<string, BetaOverride>([["4-6", { add: ["effort-2025-11-24"] }]]);

export function getCliVersion(fallback: string): string {
  return process.env.ANTHROPIC_CLI_VERSION || fallback;
}

export function getUserAgent(version: string): string {
  return process.env.ANTHROPIC_USER_AGENT || `claude-cli/${version} (external, cli)`;
}

export function getBetaFlags(defaults: string[] = baseBetas): string[] {
  const custom = process.env.ANTHROPIC_BETA_FLAGS;
  if (!custom) return defaults;
  return custom
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);
}

function isLongContextEnabled(): boolean {
  const setting = process.env.ANTHROPIC_ENABLE_1M_CONTEXT;
  return setting === "1" || setting === "true";
}

function addMissing(betas: string[], additions: string[]): void {
  for (const beta of additions) {
    if (!betas.includes(beta)) betas.push(beta);
  }
}

export function getBetasForModel(
  modelId: string,
  defaults: string[],
  options?: { enableLongContext?: boolean },
): string[] {
  let betas = [...defaults];

  if (options?.enableLongContext || isLongContextEnabled()) addMissing(betas, longContextBetas);

  for (const [pattern, override] of modelBetaOverrides) {
    if (!modelId.includes(pattern)) continue;
    addMissing(betas, override.add ?? []);
    const removals = override.remove ?? [];
    betas = betas.filter((beta) => !removals.includes(beta));
  }

  return betas;
}
