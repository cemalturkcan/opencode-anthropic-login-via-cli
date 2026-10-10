import { beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { promisify } from "node:util";
import { readClaudeCodeCredentials, readKeychainCredentials } from "../shared/credentials.ts";
import { findClaudeBinary } from "../shared/introspection.ts";
import { assertSandboxHome, resetSandbox } from "./fixtures.ts";

const execFileAsync = promisify(execFile);

beforeEach(resetSandbox);

describe("test sandbox", () => {
  it("points HOME at a temporary directory instead of the real home", () => {
    expect(process.env.HOME).not.toBe(userInfo().homedir);
    expect(process.env.HOME?.startsWith(tmpdir())).toBe(true);
  });

  it("cannot reach the real claude binary", async () => {
    expect(await findClaudeBinary()).toBeNull();
    await expect(execFileAsync("claude", ["--version"])).rejects.toThrow();
  });

  it("cannot read the real keychain", async () => {
    expect(await readKeychainCredentials()).toBeNull();
    expect(await readClaudeCodeCredentials()).toBeNull();
  });

  it("refuses network requests outside localhost", async () => {
    await expect(fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow(
      "unexpected network request in tests",
    );
  });
});

describe("assertSandboxHome", () => {
  it("accepts the sandbox home created by the preload", () => {
    expect(() => assertSandboxHome(String(process.env.HOME))).not.toThrow();
  });

  it.each(["/home/someone", "/root", "/", ""])("refuses %p", (home) => {
    expect(() => assertSandboxHome(home)).toThrow("refusing to touch");
  });
});
