import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeCommand, defaultCliVersion, isWindows, type CliIdentity } from "./constants.ts";
import { isJsonObject, isJsonString, type JsonValue } from "./json.ts";
import { log } from "./logger.ts";
import { getCliVersion, getUserAgent } from "./modelConfig.ts";
import { homeDirectory } from "./paths.ts";

const execFileAsync = promisify(execFile);
const npmRegistryUrl = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";

export function parseVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+(?:[-+][^\s]+)?)\b/)?.[1] ?? null;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function reportedVersion(installed: string | null): string {
  if (!installed || compareVersions(installed, defaultCliVersion) < 0) {
    return getCliVersion(defaultCliVersion);
  }
  return getCliVersion(installed);
}

export function cliIdentity(version: string): CliIdentity {
  return { version, userAgent: getUserAgent(version) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function firstExistingPath(candidates: string[]): Promise<string | null> {
  const present = await Promise.all(candidates.map(exists));
  return candidates[present.indexOf(true)] ?? null;
}

export async function findClaudeBinary(): Promise<string | null> {
  if (isWindows) {
    const installed = await firstExistingPath([
      join(homeDirectory(), ".claude", "local", "claude.exe"),
      join(homeDirectory(), "AppData", "Local", "Programs", "claude-code", "claude.exe"),
    ]);
    if (installed) return installed;
  }

  try {
    const { stdout } = await execFileAsync(isWindows ? "where" : "which", [claudeCommand], {
      timeout: 3000,
    });
    return stdout.trim().split(/\r?\n/)[0]?.trim() || null;
  } catch {
    log.debug("claude binary not found on path");
    return null;
  }
}

async function detectInstalledVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(claudeCommand, ["--version"], { timeout: 5000 });
    return parseVersion(stdout);
  } catch (failure) {
    log.info("claude cli version unavailable, using the default", { error: String(failure) });
    return null;
  }
}

async function fetchLatestCliVersion(installed: string): Promise<string | null> {
  const response = await fetch(npmRegistryUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;

  const body: JsonValue = await response.json();
  const latest = isJsonObject(body) && isJsonString(body.version) ? body.version : null;
  if (!latest || compareVersions(installed, latest) >= 0) return null;

  log.warn("claude cli is outdated", { installed, latest });
  return latest;
}

let currentIdentity = cliIdentity(reportedVersion(null));
let installedVersion: string | null = null;
let introPromise: Promise<void> | null = null;
let latestCliVersion: string | null = null;

export function getIntro(): CliIdentity {
  return currentIdentity;
}

export function getInstalledCliVersion(): string | null {
  return installedVersion;
}

export function getLatestCliVersion(): string | null {
  return latestCliVersion;
}

export async function awaitIntro(): Promise<CliIdentity> {
  if (introPromise) await introPromise;
  return currentIdentity;
}

function startDetachedUpdateCheck(installed: string): void {
  fetchLatestCliVersion(installed)
    .then((latest) => {
      latestCliVersion = latest;
    })
    .catch((failure) => log.debug("cli update check failed", { error: String(failure) }));
}

export function startIntro(): void {
  introPromise = detectInstalledVersion()
    .then((installed) => {
      installedVersion = installed;
      currentIdentity = cliIdentity(reportedVersion(installed));
      log.info("claude cli identity resolved", { installed, reported: currentIdentity.version });
      if (installed) startDetachedUpdateCheck(installed);
    })
    .finally(() => {
      introPromise = null;
    });
}
