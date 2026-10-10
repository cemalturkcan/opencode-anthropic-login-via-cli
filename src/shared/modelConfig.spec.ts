import { describe, expect, it, afterEach } from "bun:test";
import {
  baseBetas,
  getBetaFlags,
  getBetasForModel,
  getCliVersion,
  getUserAgent,
} from "./modelConfig.ts";

describe("baseBetas", () => {
  it("does not include context-1m by default", () => {
    expect(baseBetas.some((beta) => beta.startsWith("context-1m-"))).toBe(false);
  });

  it("includes required base betas", () => {
    expect(baseBetas).toContain("claude-code-20250219");
    expect(baseBetas).toContain("interleaved-thinking-2025-05-14");
    expect(baseBetas).toContain("oauth-2025-04-20");
    expect(baseBetas).toContain("context-management-2025-06-27");
    expect(baseBetas).toContain("prompt-caching-scope-2026-01-05");
  });
});

describe("getBetasForModel", () => {
  it("adds effort beta for 4-6 models", () => {
    const betas = getBetasForModel("claude-sonnet-4-6", [...baseBetas]);
    expect(betas).toContain("effort-2025-11-24");
  });

  it("adds effort beta when model id contains 4-6", () => {
    const betas = getBetasForModel("some-model-4-6-variant", [...baseBetas]);
    expect(betas).toContain("effort-2025-11-24");
  });

  it("does not add effort beta for non-4-6 models", () => {
    const betas = getBetasForModel("claude-sonnet-4-20250514", [...baseBetas]);
    expect(betas).not.toContain("effort-2025-11-24");
  });

  it("does not add context-1m beta by default", () => {
    const betas = getBetasForModel("claude-sonnet-4-20250514", [...baseBetas]);
    expect(betas).not.toContain("context-1m-2025-08-07");
  });

  it("adds long context betas when enableLongContext option is set", () => {
    const betas = getBetasForModel("claude-sonnet-4-20250514", [...baseBetas], {
      enableLongContext: true,
    });
    expect(betas).toContain("context-1m-2025-08-07");
  });

  it("does not duplicate betas already present", () => {
    const base = [...baseBetas, "effort-2025-11-24"];
    const betas = getBetasForModel("claude-sonnet-4-6", base);
    const effortCount = betas.filter((b) => b === "effort-2025-11-24").length;
    expect(effortCount).toBe(1);
  });
});

describe("getBetaFlags", () => {
  const originalEnv = process.env.ANTHROPIC_BETA_FLAGS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ANTHROPIC_BETA_FLAGS;
    } else {
      process.env.ANTHROPIC_BETA_FLAGS = originalEnv;
    }
  });

  it("returns base betas when no env override", () => {
    delete process.env.ANTHROPIC_BETA_FLAGS;
    const flags = getBetaFlags();
    expect(flags).toEqual(baseBetas);
  });

  it("returns custom flags from ANTHROPIC_BETA_FLAGS", () => {
    process.env.ANTHROPIC_BETA_FLAGS = "custom-beta-1,custom-beta-2";
    const flags = getBetaFlags();
    expect(flags).toEqual(["custom-beta-1", "custom-beta-2"]);
  });

  it("trims whitespace from custom flags", () => {
    process.env.ANTHROPIC_BETA_FLAGS = " a , b , c ";
    const flags = getBetaFlags();
    expect(flags).toEqual(["a", "b", "c"]);
  });

  it("filters empty entries", () => {
    process.env.ANTHROPIC_BETA_FLAGS = "a,,b,";
    const flags = getBetaFlags();
    expect(flags).toEqual(["a", "b"]);
  });
});

describe("ANTHROPIC_ENABLE_1M_CONTEXT", () => {
  const originalEnv = process.env.ANTHROPIC_ENABLE_1M_CONTEXT;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT;
    } else {
      process.env.ANTHROPIC_ENABLE_1M_CONTEXT = originalEnv;
    }
  });

  it("adds long context betas when env is '1'", () => {
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "1";
    const betas = getBetasForModel("claude-sonnet-4-20250514", [...baseBetas]);
    expect(betas).toContain("context-1m-2025-08-07");
  });

  it("adds long context betas when env is 'true'", () => {
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true";
    const betas = getBetasForModel("claude-sonnet-4-20250514", [...baseBetas]);
    expect(betas).toContain("context-1m-2025-08-07");
  });

  it("does not add when env is unset", () => {
    delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT;
    const betas = getBetasForModel("claude-sonnet-4-20250514", [...baseBetas]);
    expect(betas).not.toContain("context-1m-2025-08-07");
  });
});

describe("cli identity overrides", () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_CLI_VERSION;
    delete process.env.ANTHROPIC_USER_AGENT;
  });

  it("uses the detected version without an override", () => {
    expect(getCliVersion("2.1.0")).toBe("2.1.0");
  });

  it("prefers ANTHROPIC_CLI_VERSION over the detected version", () => {
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9";

    expect(getCliVersion("2.1.0")).toBe("9.9.9");
  });

  it("formats the claude cli user agent", () => {
    expect(getUserAgent("2.1.0")).toBe("claude-cli/2.1.0 (external, cli)");
  });

  it("prefers ANTHROPIC_USER_AGENT over the formatted user agent", () => {
    process.env.ANTHROPIC_USER_AGENT = "custom-agent";

    expect(getUserAgent("2.1.0")).toBe("custom-agent");
  });
});
