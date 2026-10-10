import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  claudeCommand,
  defaultCliVersion,
  defaultScopes,
  isWindows,
  type IntrospectionResult,
} from "./constants.ts";
import { isJsonObject, isJsonString, type JsonValue } from "./json.ts";
import { log } from "./logger.ts";
import { baseBetas, getCliVersion, getUserAgent, longContextBetas } from "./modelConfig.ts";
import { homeDirectory } from "./paths.ts";

const execFileAsync = promisify(execFile);

const knownBetaPrefixes = [
  "claude-code-",
  "interleaved-thinking-",
  "context-management-",
  "oauth-",
  "prompt-caching-scope-",
  "context-1m-",
  "effort-",
];
const requiredOAuthBeta = "oauth-2025-04-20";
const scanChunkSize = 256 * 1024;
const scanOverlap = 128;
const npmRegistryUrl = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";

export const betaPattern =
  /(?<![a-z0-9-])(?:claude-code-\d{8}|[a-z0-9]+(?:-[a-z0-9]+)*-20\d{2}-\d{2}-\d{2})(?![a-z0-9-])/g;
export const scopePattern = /(?:user|org):[a-z][a-z0-9_]+(?::[a-z][a-z0-9_]+)*/g;

export function filterBetaHeaders(candidates: string[]): string[] {
  const headers = candidates.filter((header) =>
    knownBetaPrefixes.some((prefix) => header.startsWith(prefix)),
  );
  if (!headers.some((header) => header.startsWith("oauth-"))) headers.push(requiredOAuthBeta);
  return headers;
}

export function filterScopes(candidates: string[]): string[] {
  return candidates.filter(
    (scope) =>
      !scope.includes("this") &&
      !scope.endsWith(":") &&
      (scope.startsWith("user:") || scope.startsWith("org:")),
  );
}

export function removeLongContextBetas(betas: string[]): string[] {
  const prefixes = longContextBetas.map((beta) => beta.replace(/-\d{4}-\d{2}-\d{2}$/, "-"));
  return betas.filter((beta) => !prefixes.some((prefix) => beta.startsWith(prefix)));
}

export function parseVersion(output: string): string {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:[-+][^\s]+)?)\b/);
  return match?.[1] ?? defaultCliVersion;
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

export function scanBinary(binaryPath: string, patterns: RegExp[]): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const matches = patterns.map(() => new Set<string>());
    const globalPatterns = patterns.map(
      (pattern) =>
        new RegExp(
          pattern.source,
          pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
        ),
    );
    let tail = "";

    const stream = createReadStream(binaryPath, { highWaterMark: scanChunkSize });
    stream.on("data", (chunk: Buffer) => {
      const text = tail + chunk.toString("latin1");
      globalPatterns.forEach((pattern, index) => {
        for (const match of text.matchAll(pattern)) matches[index].add(match[0]);
      });
      tail = text.slice(-scanOverlap);
    });
    stream.on("end", () => resolve(matches.map((set) => Array.from(set))));
    stream.on("error", reject);
  });
}

async function grepBinaryStrings(binaryPath: string, pattern: string): Promise<string[]> {
  const quotedPath = binaryPath.replace(/'/g, "'\\''");
  const { stdout } = await execFileAsync(
    "sh",
    ["-c", `strings '${quotedPath}' | grep -oE '${pattern}' | sort -u`],
    { timeout: 30_000 },
  );
  return stdout.trim().split("\n").filter(Boolean);
}

type BinaryStrings = { betas: string[] | null; scopes: string[] | null };

async function extractFromBinaryWindows(binaryPath: string): Promise<BinaryStrings> {
  const [betas, scopes] = await scanBinary(binaryPath, [betaPattern, scopePattern]);
  return { betas, scopes };
}

async function extractFromBinaryUnix(binaryPath: string): Promise<BinaryStrings> {
  const [betas, scopes] = await Promise.allSettled([
    grepBinaryStrings(
      binaryPath,
      "[a-z0-9]+(-[a-z0-9]+)*-20[0-9]{2}-[0-9]{2}-[0-9]{2}|claude-code-[0-9]+",
    ),
    grepBinaryStrings(binaryPath, "(user|org):[a-z][a-z0-9_]+(:[a-z][a-z0-9_]+)*"),
  ]);
  if (betas.status === "rejected") {
    log.warn("failed to extract beta headers from binary", { error: String(betas.reason) });
  }
  if (scopes.status === "rejected") {
    log.warn("failed to extract scopes from binary", { error: String(scopes.reason) });
  }
  return {
    betas: betas.status === "fulfilled" ? betas.value : null,
    scopes: scopes.status === "fulfilled" ? scopes.value : null,
  };
}

export function resolveIntrospection(
  version: string,
  extracted: BinaryStrings,
): IntrospectionResult {
  const betas = extracted.betas ? removeLongContextBetas(filterBetaHeaders(extracted.betas)) : [];
  const scopes = extracted.scopes ? filterScopes(extracted.scopes) : [];
  return {
    version,
    userAgent: getUserAgent(version),
    betaHeaders: betas.length > 0 ? betas : baseBetas,
    scopes: scopes.length > 0 ? scopes.join(" ") : defaultScopes,
  };
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

function staticIntrospection(version: string): IntrospectionResult {
  return {
    version,
    userAgent: getUserAgent(version),
    betaHeaders: baseBetas,
    scopes: defaultScopes,
  };
}

async function introspectClaudeBinary(): Promise<IntrospectionResult | null> {
  try {
    const { stdout } = await execFileAsync(claudeCommand, ["--version"], { timeout: 5000 });
    const version = getCliVersion(parseVersion(stdout));
    log.info("claude cli version detected", { version });

    const binaryPath = await findClaudeBinary();
    if (!binaryPath) {
      log.info("claude binary not found on disk, using static defaults");
      return staticIntrospection(version);
    }

    const extracted = isWindows
      ? await extractFromBinaryWindows(binaryPath)
      : await extractFromBinaryUnix(binaryPath);
    const result = resolveIntrospection(version, extracted);
    log.info("introspection complete", { version, betas: result.betaHeaders });
    return result;
  } catch (failure) {
    log.error("introspection failed", { error: String(failure) });
    return null;
  }
}

async function fetchLatestCliVersion(currentVersion: string): Promise<string | null> {
  const response = await fetch(npmRegistryUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;

  const body: JsonValue = await response.json();
  const version = isJsonObject(body) && isJsonString(body.version) ? body.version : null;
  if (!version || compareVersions(currentVersion, version) >= 0) return null;

  log.warn("claude cli is outdated", { current: currentVersion, latest: version });
  return version;
}

let currentIntro = staticIntrospection(defaultCliVersion);
let introPromise: Promise<void> | null = null;
let latestCliVersion: string | null = null;

export function getIntro(): IntrospectionResult {
  return currentIntro;
}

export function getLatestCliVersion(): string | null {
  return latestCliVersion;
}

export async function awaitIntro(): Promise<IntrospectionResult> {
  if (introPromise) await introPromise;
  return currentIntro;
}

function startDetachedUpdateCheck(version: string): void {
  fetchLatestCliVersion(version)
    .then((latest) => {
      latestCliVersion = latest;
    })
    .catch((failure) => log.debug("cli update check failed", { error: String(failure) }));
}

export function startIntro(): void {
  introPromise = introspectClaudeBinary()
    .then((result) => {
      if (result) currentIntro = result;
      startDetachedUpdateCheck(currentIntro.version);
    })
    .finally(() => {
      introPromise = null;
    });
}
