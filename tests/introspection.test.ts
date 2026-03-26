import { describe, expect, it } from "bun:test";

const BETA_RE =
  /(?<![a-z0-9-])(?:claude-code-\d{8}|[a-z0-9]+(?:-[a-z0-9]+)*-20\d{2}-\d{2}-\d{2})(?![a-z0-9-])/g;

const SCOPE_RE = /(?:user|org):[a-z0-9:_-]+/g;

const KNOWN_BETA_PREFIXES = [
  "claude-code-",
  "interleaved-thinking-",
  "context-management-",
  "oauth-",
  "prompt-caching-scope-",
  "context-1m-",
  "effort-",
];

function extractBetas(text: string): string[] {
  const matches = text.match(BETA_RE) ?? [];
  return matches.filter((h) => KNOWN_BETA_PREFIXES.some((p) => h.startsWith(p)));
}

function extractScopes(text: string): string[] {
  const matches = text.match(SCOPE_RE) ?? [];
  return matches.filter(
    (s) =>
      !s.includes("this") && !s.endsWith(":") && (s.startsWith("user:") || s.startsWith("org:")),
  );
}

function parseVersion(output: string): string {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:[-+][^\s]+)?)\b/);
  return match?.[1] ?? "2.1.80";
}

describe("BETA_RE", () => {
  it("matches claude-code date format", () => {
    expect(extractBetas("claude-code-20250219")).toEqual(["claude-code-20250219"]);
  });

  it("matches two-segment betas", () => {
    expect(extractBetas("interleaved-thinking-2025-05-14")).toEqual([
      "interleaved-thinking-2025-05-14",
    ]);
  });

  it("matches three-segment betas (Issue #5 regression)", () => {
    const result = extractBetas("prompt-caching-scope-2026-01-05");
    expect(result).toEqual(["prompt-caching-scope-2026-01-05"]);
  });

  it("matches context-1m beta", () => {
    expect(extractBetas("context-1m-2025-08-07")).toEqual(["context-1m-2025-08-07"]);
  });

  it("matches effort beta", () => {
    expect(extractBetas("effort-2025-11-24")).toEqual(["effort-2025-11-24"]);
  });

  it("matches oauth beta", () => {
    expect(extractBetas("oauth-2025-04-20")).toEqual(["oauth-2025-04-20"]);
  });

  it("extracts multiple betas from binary-like text", () => {
    const text =
      "some binary content claude-code-20250219 more stuff interleaved-thinking-2025-05-14 and context-management-2025-06-27 end";
    const result = extractBetas(text);
    expect(result).toContain("claude-code-20250219");
    expect(result).toContain("interleaved-thinking-2025-05-14");
    expect(result).toContain("context-management-2025-06-27");
  });

  it("does not match partial strings", () => {
    expect(extractBetas("notabeta-2025-01-01")).toEqual([]);
  });

  it("does not match betas embedded in longer identifiers", () => {
    const re = new RegExp(BETA_RE.source, "g");
    const text = "xoauth-2025-04-20y";
    const matches = text.match(re) ?? [];
    // lookbehind/lookahead should prevent match when surrounded by [a-z0-9-]
    expect(matches.length).toBe(0);
  });
});

describe("SCOPE_RE", () => {
  it("matches user scopes", () => {
    expect(extractScopes("user:inference")).toEqual(["user:inference"]);
  });

  it("matches nested scopes with colons", () => {
    expect(extractScopes("user:sessions:claude_code")).toEqual(["user:sessions:claude_code"]);
  });

  it("matches org scopes", () => {
    expect(extractScopes("org:create_api_key")).toEqual(["org:create_api_key"]);
  });

  it("matches scopes with hyphens", () => {
    expect(extractScopes("user:some-scope")).toEqual(["user:some-scope"]);
  });

  it("matches scopes with digits", () => {
    expect(extractScopes("user:scope123")).toEqual(["user:scope123"]);
  });

  it("extracts multiple scopes", () => {
    const text = "user:inference user:profile org:create_api_key";
    const result = extractScopes(text);
    expect(result.length).toBe(3);
  });
});

describe("parseVersion", () => {
  it("parses simple version", () => {
    expect(parseVersion("2.1.80")).toBe("2.1.80");
  });

  it("parses version from 'Claude Code 2.1.80'", () => {
    expect(parseVersion("Claude Code 2.1.80")).toBe("2.1.80");
  });

  it("parses version from 'claude 2.1.80'", () => {
    expect(parseVersion("claude 2.1.80")).toBe("2.1.80");
  });

  it("parses version with pre-release suffix", () => {
    expect(parseVersion("3.0.0-beta.1")).toBe("3.0.0-beta.1");
  });

  it("returns default for empty output", () => {
    expect(parseVersion("")).toBe("2.1.80");
  });

  it("returns default for non-version text", () => {
    expect(parseVersion("not a version")).toBe("2.1.80");
  });
});

describe("context-1m filtering", () => {
  const LONG_CONTEXT_BETAS = ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"];

  function filterLongContextBetas(betas: string[]): string[] {
    const longCtxPrefixes = LONG_CONTEXT_BETAS.map((b) => b.replace(/-\d{4}-\d{2}-\d{2}$/, "-"));
    return betas.filter((h) => !longCtxPrefixes.some((p) => h.startsWith(p)));
  }

  it("removes context-1m from introspection results", () => {
    const input = ["claude-code-20250219", "context-1m-2025-08-07", "oauth-2025-04-20"];
    const result = filterLongContextBetas(input);
    expect(result).not.toContain("context-1m-2025-08-07");
    expect(result).toContain("claude-code-20250219");
    expect(result).toContain("oauth-2025-04-20");
  });

  it("removes interleaved-thinking from long context betas", () => {
    const input = ["claude-code-20250219", "interleaved-thinking-2025-05-14", "oauth-2025-04-20"];
    const result = filterLongContextBetas(input);
    expect(result).not.toContain("interleaved-thinking-2025-05-14");
  });

  it("handles future date versions of context-1m", () => {
    const input = ["context-1m-2026-01-01"];
    const result = filterLongContextBetas(input);
    expect(result).toEqual([]);
  });
});
