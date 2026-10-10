import { afterEach, describe, expect, it } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { debugLogPath } from "./paths.ts";
import { reportVersionGate } from "./versionGate.ts";

afterEach(async () => {
  process.env.CLAUDE_AUTH_DEBUG = "0";
  await rm(debugLogPath(), { force: true });
});

describe("reportVersionGate", () => {
  it("logs the version gate and keeps the response readable", async () => {
    process.env.CLAUDE_AUTH_DEBUG = "1";
    const body = '{"error":{"type":"claude_code_version_too_old","message":"upgrade"}}';

    const response = await reportVersionGate(new Response(body, { status: 400 }));

    expect(await response.text()).toBe(body);
    expect(await readFile(debugLogPath(), "utf-8")).toContain(
      "anthropic rejected the reported claude code version",
    );
  });

  it("passes other responses through untouched", async () => {
    const response = new Response("ok");

    expect(await reportVersionGate(response)).toBe(response);
  });
});
