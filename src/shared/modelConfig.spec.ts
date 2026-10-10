import { afterEach, describe, expect, it } from "bun:test";
import {
  claudeCodeBetas,
  getBetaFlags,
  getBetasForModel,
  getCliVersion,
  getUserAgent,
  isNativeLongContextModel,
} from "./modelConfig.ts";

afterEach(() => {
  delete process.env.ANTHROPIC_BETA_FLAGS;
  delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT;
  delete process.env.ANTHROPIC_CLI_VERSION;
  delete process.env.ANTHROPIC_USER_AGENT;
});

describe("claudeCodeBetas", () => {
  it("matches the betas claude code 2.1.296 sends for every model", () => {
    expect(claudeCodeBetas).toEqual([
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
    ]);
  });

  it("never includes the long-context beta by default", () => {
    expect(claudeCodeBetas.some((beta) => beta.startsWith("context-1m-"))).toBe(false);
  });
});

describe("getBetaFlags", () => {
  it("returns the claude code betas without an override", () => {
    expect(getBetaFlags()).toEqual(claudeCodeBetas);
  });

  it("uses trimmed, non-empty ANTHROPIC_BETA_FLAGS entries", () => {
    process.env.ANTHROPIC_BETA_FLAGS = " a ,, b ,";

    expect(getBetaFlags()).toEqual(["a", "b"]);
  });
});

describe("isNativeLongContextModel", () => {
  it.each([
    "claude-sonnet-5-5",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-1",
    "claude-mythos-5",
    "claude-opus-4-7",
    "claude-opus-4-8",
  ])("treats %s as native 1M", (model) => {
    expect(isNativeLongContextModel(model)).toBe(true);
  });

  it.each(["claude-sonnet-4-5", "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"])(
    "treats %s as needing the long-context beta",
    (model) => {
      expect(isNativeLongContextModel(model)).toBe(false);
    },
  );
});

describe("getBetasForModel", () => {
  it("keeps the betas unchanged without the long-context opt-in", () => {
    expect(getBetasForModel("claude-sonnet-4-6", claudeCodeBetas)).toEqual(claudeCodeBetas);
  });

  it.each(["1", "true"])(
    "adds the long-context beta for 4.x models when opted in with %s",
    (value) => {
      process.env.ANTHROPIC_ENABLE_1M_CONTEXT = value;

      expect(getBetasForModel("claude-sonnet-4-6", claudeCodeBetas)).toContain(
        "context-1m-2025-08-07",
      );
    },
  );

  it("skips the long-context beta for native 1M models", () => {
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "1";

    expect(getBetasForModel("claude-opus-5-5", claudeCodeBetas)).not.toContain(
      "context-1m-2025-08-07",
    );
  });

  it("does not duplicate a beta that is already present", () => {
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "1";
    const betas = getBetasForModel("claude-sonnet-4-6", [
      ...claudeCodeBetas,
      "context-1m-2025-08-07",
    ]);

    expect(betas.filter((beta) => beta === "context-1m-2025-08-07")).toHaveLength(1);
  });
});

describe("cli identity", () => {
  it("prefers ANTHROPIC_CLI_VERSION over the detected version", () => {
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9";

    expect(getCliVersion("2.1.0")).toBe("9.9.9");
  });

  it("formats the user agent with the sdk-cli entrypoint claude code uses in print mode", () => {
    expect(getUserAgent("2.1.296")).toBe("claude-cli/2.1.296 (external, sdk-cli)");
  });

  it("prefers ANTHROPIC_USER_AGENT", () => {
    process.env.ANTHROPIC_USER_AGENT = "custom-agent";

    expect(getUserAgent("2.1.296")).toBe("custom-agent");
  });
});
