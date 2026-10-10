import { afterEach, describe, expect, it } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { isDebugEnabled, log, redact } from "./logger.ts";
import { debugLogPath } from "./paths.ts";

afterEach(async () => {
  process.env.CLAUDE_AUTH_DEBUG = "0";
  await rm(debugLogPath(), { force: true });
});

describe("redact", () => {
  it("masks sensitive keys at any depth", () => {
    expect(
      redact({
        access: "sk-ant-oat01-secret",
        nested: { refresh_token: "r", apiKey: 7 },
        status: 400,
      }),
    ).toEqual({
      access: "sk-ant-o...[REDACTED]",
      nested: { refresh_token: "r...[REDACTED]", apiKey: "[REDACTED]" },
      status: 400,
    });
  });

  it("masks token-shaped strings under harmless keys", () => {
    expect(redact({ value: "abcdefghijklmnopqrstuvwxyz" })).toEqual({
      value: "abcdefgh...[REDACTED]",
    });
    expect(redact("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature")).toBe(
      "eyJhbGciOi...[REDACTED]",
    );
  });

  it("keeps ordinary text readable", () => {
    expect(redact({ message: "token refresh failed" })).toEqual({
      message: "token refresh failed",
    });
  });
});

describe("log", () => {
  it.each(["0", "false"])("stays disabled when CLAUDE_AUTH_DEBUG is %s", (value) => {
    process.env.CLAUDE_AUTH_DEBUG = value;

    expect(isDebugEnabled()).toBe(false);
  });

  it("writes redacted json lines when enabled", async () => {
    process.env.CLAUDE_AUTH_DEBUG = "1";

    await log.warn("token refresh failed", { refresh: "secret-refresh-token" });

    const entry = JSON.parse(await readFile(debugLogPath(), "utf-8"));
    expect(entry).toMatchObject({
      level: "warn",
      msg: "token refresh failed",
      data: { refresh: "secret-r...[REDACTED]" },
    });
  });
});
