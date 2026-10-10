import { describe, expect, it } from "bun:test";
import { defaultCliVersion, defaultScopes } from "./constants.ts";
import {
  betaPattern,
  compareVersions,
  filterBetaHeaders,
  filterScopes,
  parseVersion,
  removeLongContextBetas,
  resolveIntrospection,
  scopePattern,
} from "./introspection.ts";
import { baseBetas } from "./modelConfig.ts";

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

describe("betaPattern", () => {
  it.each([
    "claude-code-20250219",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-1m-2025-08-07",
    "effort-2025-11-24",
    "oauth-2025-04-20",
  ])("matches %s", (beta) => {
    expect(matches(beta, betaPattern)).toEqual([beta]);
  });

  it("extracts several betas from binary-like text", () => {
    const text =
      "\u0000claude-code-20250219\u0001interleaved-thinking-2025-05-14 context-management-2025-06-27";

    expect(matches(text, betaPattern)).toEqual([
      "claude-code-20250219",
      "interleaved-thinking-2025-05-14",
      "context-management-2025-06-27",
    ]);
  });

  it("does not match betas embedded in longer identifiers", () => {
    expect(matches("xoauth-2025-04-20y", betaPattern)).toEqual([]);
  });
});

describe("scopePattern", () => {
  it("matches user, org and nested scopes", () => {
    const text = "user:inference org:create_api_key user:sessions:claude_code user:scope123";

    expect(matches(text, scopePattern)).toEqual([
      "user:inference",
      "org:create_api_key",
      "user:sessions:claude_code",
      "user:scope123",
    ]);
  });

  it("stops a scope at a hyphen", () => {
    expect(matches("user:some-scope", scopePattern)).toEqual(["user:some"]);
  });
});

describe("filterBetaHeaders", () => {
  it("keeps only known beta families", () => {
    expect(
      filterBetaHeaders(["claude-code-20250219", "notabeta-2025-01-01", "oauth-2025-04-20"]),
    ).toEqual(["claude-code-20250219", "oauth-2025-04-20"]);
  });

  it("adds the oauth beta when the binary does not mention one", () => {
    expect(filterBetaHeaders(["claude-code-20250219"])).toContain("oauth-2025-04-20");
  });
});

describe("filterScopes", () => {
  it("drops prose matches and trailing colons", () => {
    expect(filterScopes(["user:inference", "user:this_thing", "org:"])).toEqual(["user:inference"]);
  });
});

describe("removeLongContextBetas", () => {
  it("removes every dated context-1m beta and keeps the rest", () => {
    expect(
      removeLongContextBetas([
        "claude-code-20250219",
        "context-1m-2025-08-07",
        "context-1m-2026-01-01",
        "interleaved-thinking-2025-05-14",
      ]),
    ).toEqual(["claude-code-20250219", "interleaved-thinking-2025-05-14"]);
  });
});

describe("resolveIntrospection", () => {
  it("uses extracted betas and scopes", () => {
    const result = resolveIntrospection("2.1.90", {
      betas: ["claude-code-20250219", "context-1m-2025-08-07"],
      scopes: ["user:inference", "user:profile"],
    });

    expect(result).toEqual({
      version: "2.1.90",
      userAgent: "claude-cli/2.1.90 (external, cli)",
      betaHeaders: ["claude-code-20250219", "oauth-2025-04-20"],
      scopes: "user:inference user:profile",
    });
  });

  it("falls back to static defaults when extraction failed", () => {
    const result = resolveIntrospection("2.1.90", { betas: null, scopes: null });

    expect(result.betaHeaders).toEqual(baseBetas);
    expect(result.scopes).toBe(defaultScopes);
  });
});

describe("parseVersion", () => {
  it.each([
    ["2.1.80", "2.1.80"],
    ["Claude Code 2.1.80", "2.1.80"],
    ["claude 2.1.80", "2.1.80"],
    ["2.1.80-beta.1", "2.1.80-beta.1"],
  ])("parses %s", (output, version) => {
    expect(parseVersion(output)).toBe(version);
  });

  it.each(["", "not a version"])("falls back to the default version for %p", (output) => {
    expect(parseVersion(output)).toBe(defaultCliVersion);
  });
});

describe("compareVersions", () => {
  it.each([
    ["2.1.80", "2.1.80", 0],
    ["2.1.80", "2.2.0", -1],
    ["3.0.0", "2.9.99", 1],
    ["1.9.9", "2.0.0", -1],
    ["2.1.79", "2.1.80", -1],
  ] as const)("compares %s with %s", (left, right, sign) => {
    expect(Math.sign(compareVersions(left, right))).toBe(sign);
  });
});
