import { beforeEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { installClaudeBinary, resetSandbox } from "../testing/fixtures.ts";
import { commandOptions, runCommand } from "./process.ts";

beforeEach(resetSandbox);

const sourceRoot = join(import.meta.dir, "..");

async function productionSources(): Promise<string[]> {
  const files = await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot }));
  return files.filter((file) => !file.startsWith("testing/") && !file.endsWith(".spec.ts"));
}

describe("commandOptions", () => {
  it("hides the console window of every child process", () => {
    expect(commandOptions().windowsHide).toBe(true);
  });

  it("keeps the caller options next to the hidden window", () => {
    const env = { TERM: "dumb" };
    expect(commandOptions({ timeout: 3000, env })).toEqual({
      timeout: 3000,
      env,
      windowsHide: true,
    });
  });
});

describe("runCommand", () => {
  it("returns the standard output of the command", async () => {
    await installClaudeBinary("2.1.311");
    const { stdout } = await runCommand("claude", ["--version"], { timeout: 5000 });
    expect(stdout.trim()).toBe("2.1.311 (Claude Code)");
  });

  it("rejects when the command is missing", async () => {
    await expect(runCommand("claude", ["--version"])).rejects.toThrow();
  });

  it("is the only production code that starts child processes", async () => {
    const files = await productionSources();
    const contents = await Promise.all(
      files.map((file) => readFile(join(sourceRoot, file), "utf-8")),
    );
    const spawners = files.filter((_file, index) => contents[index].includes("node:child_process"));
    expect(spawners).toEqual(["shared/process.ts"]);
  });
});
