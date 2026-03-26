import { describe, expect, it, afterEach } from "bun:test";
import { getBetasForModel, getBetaFlags, BASE_BETAS } from "../src/model-config.ts";

describe("BASE_BETAS", () => {
  it("does not include context-1m by default", () => {
    expect(BASE_BETAS.some((b) => b.startsWith("context-1m-"))).toBe(false);
  });

  it("includes required base betas", () => {
    expect(BASE_BETAS).toContain("claude-code-20250219");
    expect(BASE_BETAS).toContain("interleaved-thinking-2025-05-14");
    expect(BASE_BETAS).toContain("oauth-2025-04-20");
    expect(BASE_BETAS).toContain("context-management-2025-06-27");
    expect(BASE_BETAS).toContain("prompt-caching-scope-2026-01-05");
  });
});

describe("getBetasForModel", () => {
  it("adds effort beta for 4-6 models", () => {
    const betas = getBetasForModel("claude-sonnet-4-6", [...BASE_BETAS]);
    expect(betas).toContain("effort-2025-11-24");
  });

  it("adds effort beta when model id contains 4-6", () => {
    const betas = getBetasForModel("some-model-4-6-variant", [...BASE_BETAS]);
    expect(betas).toContain("effort-2025-11-24");
  });

  it("does not add effort beta for non-4-6 models", () => {
    const betas = getBetasForModel("claude-sonnet-4-20250514", [...BASE_BETAS]);
    expect(betas).not.toContain("effort-2025-11-24");
  });

  it("does not add context-1m beta by default", () => {
    const betas = getBetasForModel("claude-sonnet-4-20250514", [...BASE_BETAS]);
    expect(betas).not.toContain("context-1m-2025-08-07");
  });

  it("adds long context betas when enableLongContext option is set", () => {
    const betas = getBetasForModel("claude-sonnet-4-20250514", [...BASE_BETAS], {
      enableLongContext: true,
    });
    expect(betas).toContain("context-1m-2025-08-07");
  });

  it("does not duplicate betas already present", () => {
    const base = [...BASE_BETAS, "effort-2025-11-24"];
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
    expect(flags).toEqual(BASE_BETAS);
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
    const betas = getBetasForModel("claude-sonnet-4-20250514", [...BASE_BETAS]);
    expect(betas).toContain("context-1m-2025-08-07");
    expect(betas).toContain("interleaved-thinking-2025-05-14");
  });

  it("adds long context betas when env is 'true'", () => {
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true";
    const betas = getBetasForModel("claude-sonnet-4-20250514", [...BASE_BETAS]);
    expect(betas).toContain("context-1m-2025-08-07");
  });

  it("does not add when env is unset", () => {
    delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT;
    const betas = getBetasForModel("claude-sonnet-4-20250514", [...BASE_BETAS]);
    expect(betas).not.toContain("context-1m-2025-08-07");
  });
});
