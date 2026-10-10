import { beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFetch, restoreFetchAfterEach } from "../testing/fetch.ts";
import { installClaudeBinary, resetSandbox } from "../testing/fixtures.ts";
import { cliDetectionInstructions } from "./authCopy.ts";
import {
  awaitIntro,
  betaPattern,
  findClaudeBinary,
  firstExistingPath,
  getLatestCliVersion,
  scanBinary,
  scopePattern,
  startIntro,
} from "./introspection.ts";
import { homeDirectory } from "./paths.ts";

restoreFetchAfterEach();
beforeEach(resetSandbox);

async function waitFor(condition: () => boolean, attemptsLeft = 100): Promise<void> {
  if (condition() || attemptsLeft === 0) return;
  await Bun.sleep(10);
  return waitFor(condition, attemptsLeft - 1);
}

describe("findClaudeBinary", () => {
  it("returns the claude binary from the path", async () => {
    await installClaudeBinary("2.1.90", []);

    expect(await findClaudeBinary()).toEndWith("/claude");
  });

  it("returns null without a claude binary", async () => {
    expect(await findClaudeBinary()).toBeNull();
  });
});

describe("startIntro", () => {
  it("reads the version, betas and scopes from the installed cli", async () => {
    await installClaudeBinary("2.1.90", [
      "claude-code-20250219",
      "interleaved-thinking-2025-05-14",
      "context-1m-2025-08-07",
      "user:inference",
      "user:profile",
    ]);
    replaceFetch(() => Response.json({ version: "2.1.90" }));

    startIntro();
    const intro = await awaitIntro();

    expect(intro.version).toBe("2.1.90");
    expect(intro.userAgent).toBe("claude-cli/2.1.90 (external, cli)");
    expect(intro.betaHeaders).toEqual([
      "claude-code-20250219",
      "interleaved-thinking-2025-05-14",
      "oauth-2025-04-20",
    ]);
    expect(intro.scopes).toBe("user:inference user:profile");
  });

  it("flags an outdated cli in the login instructions", async () => {
    await installClaudeBinary("2.1.90", ["claude-code-20250219"]);
    replaceFetch(() => Response.json({ version: "2.2.0" }));

    startIntro();
    await awaitIntro();
    await waitFor(() => getLatestCliVersion() === "2.2.0");

    expect(cliDetectionInstructions()).toContain("installed 2.1.90, latest 2.2.0");
  });

  it("keeps the previous result when the cli is missing", async () => {
    await installClaudeBinary("2.1.91", ["claude-code-20250219"]);
    replaceFetch(() => Response.json({ version: "2.1.91" }));
    startIntro();
    const before = await awaitIntro();
    await resetSandbox();

    startIntro();

    expect(await awaitIntro()).toEqual(before);
  });
});

describe("scanBinary", () => {
  it("finds every pattern match, including one split across read chunks", async () => {
    const path = join(homeDirectory(), "claude.exe");
    const padding = "\u0000".repeat(256 * 1024 - 10);
    await writeFile(path, `${padding}oauth-2025-04-20 user:inference claude-code-20250219`);

    const [betas, scopes] = await scanBinary(path, [betaPattern, scopePattern]);

    expect(betas).toEqual(["oauth-2025-04-20", "claude-code-20250219"]);
    expect(scopes).toEqual(["user:inference"]);
  });

  it("rejects when the binary cannot be read", async () => {
    await expect(scanBinary(join(homeDirectory(), "missing.exe"), [betaPattern])).rejects.toThrow();
  });
});

describe("firstExistingPath", () => {
  it("returns the first candidate that exists", async () => {
    const present = join(homeDirectory(), "present");
    await writeFile(present, "");

    expect(await firstExistingPath([join(homeDirectory(), "absent"), present])).toBe(present);
  });

  it("returns null when no candidate exists", async () => {
    expect(await firstExistingPath([join(homeDirectory(), "absent")])).toBeNull();
  });
});
