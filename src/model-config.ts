import { log } from "./logger.ts";

// ── Static Beta Configuration ────────────────────────────────────────────────
// Source of truth when binary introspection is unavailable or incomplete.

export const BASE_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "oauth-2025-04-20",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
];

export const LONG_CONTEXT_BETAS = ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"];

/** Per-model beta overrides (matched via substring) */
const MODEL_OVERRIDES: Record<string, { add?: string[]; remove?: string[] }> = {
  "4-6": { add: ["effort-2025-11-24"] },
};

// ── Environment Variable Overrides ───────────────────────────────────────────

export function getCliVersion(fallback: string): string {
  return process.env.ANTHROPIC_CLI_VERSION || fallback;
}

export function getUserAgent(version: string): string {
  if (process.env.ANTHROPIC_USER_AGENT) return process.env.ANTHROPIC_USER_AGENT;
  return `claude-cli/${version} (external, cli)`;
}

/**
 * Resolve beta flags — env var override takes full precedence.
 * Otherwise uses the provided base (from introspection or static defaults).
 */
export function getBetaFlags(baseBetas?: string[]): string[] {
  if (process.env.ANTHROPIC_BETA_FLAGS) {
    const custom = process.env.ANTHROPIC_BETA_FLAGS.split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    log.info("Using custom beta flags from ANTHROPIC_BETA_FLAGS", {
      flags: custom,
    });
    return custom;
  }
  return baseBetas ?? BASE_BETAS;
}

/**
 * Get betas for a specific model, applying per-model overrides
 * and optionally including long-context betas.
 */
export function getBetasForModel(
  modelId: string,
  baseBetas: string[],
  options?: { enableLongContext?: boolean },
): string[] {
  let betas = [...baseBetas];

  // Long-context betas — opt-in via env var
  const longContextEnabled =
    options?.enableLongContext ||
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT === "1" ||
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT === "true";

  if (longContextEnabled) {
    for (const beta of LONG_CONTEXT_BETAS) {
      if (!betas.includes(beta)) betas.push(beta);
    }
  }

  // Per-model overrides
  for (const [pattern, overrides] of Object.entries(MODEL_OVERRIDES)) {
    if (modelId.includes(pattern)) {
      if (overrides.add) {
        for (const beta of overrides.add) {
          if (!betas.includes(beta)) betas.push(beta);
        }
      }
      if (overrides.remove) {
        betas = betas.filter((b) => !overrides.remove!.includes(b));
      }
    }
  }

  return betas;
}
