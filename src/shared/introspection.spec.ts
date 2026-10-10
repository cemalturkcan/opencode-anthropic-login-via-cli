import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFetch, restoreFetchAfterEach } from "../testing/fetch.ts";
import { installClaudeBinary, resetSandbox } from "../testing/fixtures.ts";
import { cliDetectionInstructions } from "./authCopy.ts";
import { defaultCliVersion } from "./constants.ts";
import {
  awaitIntro,
  compareVersions,
  findClaudeBinary,
  firstExistingPath,
  getInstalledCliVersion,
  getLatestCliVersion,
  parseVersion,
  reportedVersion,
  startIntro,
} from "./introspection.ts";
import { homeDirectory } from "./paths.ts";

restoreFetchAfterEach();
beforeEach(resetSandbox);
afterEach(() => {
  delete process.env.ANTHROPIC_CLI_VERSION;
});

async function waitFor(condition: () => boolean, attemptsLeft = 100): Promise<void> {
  if (condition() || attemptsLeft === 0) return;
  await Bun.sleep(10);
  return waitFor(condition, attemptsLeft - 1);
}

describe("parseVersion", () => {
  it.each([
    ["2.1.80", "2.1.80"],
    ["2.1.296 (Claude Code)", "2.1.296"],
    ["claude 2.1.80", "2.1.80"],
    ["2.1.80-beta.1", "2.1.80-beta.1"],
  ])("parses %s", (output, version) => {
    expect(parseVersion(output)).toBe(version);
  });

  it.each(["", "not a version"])("returns null for %p", (output) => {
    expect(parseVersion(output)).toBeNull();
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

describe("reportedVersion", () => {
  it("reports the default when no cli is installed", () => {
    expect(reportedVersion(null)).toBe(defaultCliVersion);
  });

  it("never reports a version older than the default", () => {
    expect(reportedVersion("2.1.84")).toBe(defaultCliVersion);
  });

  it("reports a newer installed cli as is", () => {
    expect(reportedVersion("9.0.0")).toBe("9.0.0");
  });

  it("lets ANTHROPIC_CLI_VERSION override everything", () => {
    process.env.ANTHROPIC_CLI_VERSION = "1.0.0";

    expect(reportedVersion("9.0.0")).toBe("1.0.0");
  });
});

describe("findClaudeBinary", () => {
  it("returns the claude binary from the path", async () => {
    await installClaudeBinary("2.1.296");

    expect(await findClaudeBinary()).toEndWith("/claude");
  });

  it("returns null without a claude binary", async () => {
    expect(await findClaudeBinary()).toBeNull();
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

describe("startIntro", () => {
  it("reports at least the default version for an older installed cli", async () => {
    await installClaudeBinary("2.1.90");
    replaceFetch(() => Response.json({ version: "2.1.90" }));

    startIntro();
    const intro = await awaitIntro();

    expect(getInstalledCliVersion()).toBe("2.1.90");
    expect(intro.version).toBe(defaultCliVersion);
    expect(intro.userAgent).toBe(`claude-cli/${defaultCliVersion} (external, sdk-cli)`);
  });

  it("flags an outdated cli in the login instructions", async () => {
    await installClaudeBinary("2.1.90");
    replaceFetch(() => Response.json({ version: "2.2.0" }));

    startIntro();
    await awaitIntro();
    await waitFor(() => getLatestCliVersion() === "2.2.0");

    expect(cliDetectionInstructions()).toContain("installed 2.1.90, latest 2.2.0");
  });

  it("falls back to the default identity when the cli is missing", async () => {
    startIntro();

    expect((await awaitIntro()).version).toBe(defaultCliVersion);
    expect(getInstalledCliVersion()).toBeNull();
  });
});
