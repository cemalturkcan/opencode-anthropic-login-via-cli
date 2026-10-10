import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeCommand, isMac, refreshBufferMs, type OAuthTokens } from "./constants.ts";
import { findClaudeBinary } from "./introspection.ts";
import { isJsonNumber, isJsonObject, isJsonString, parseJson } from "./json.ts";
import { log } from "./logger.ts";
import { refreshTokensOnce } from "./oauthClient.ts";
import { ccsInstancesDirectory, claudeCredentialsPath } from "./paths.ts";

const execFileAsync = promisify(execFile);
const keychainService = "Claude Code-credentials";

export type CCSInstance = { name: string; credentialsPath: string };

export function isExpiringSoon(expiresAt: number): boolean {
  return Date.now() + refreshBufferMs >= expiresAt;
}

export function parseCredentialJson(raw: string): OAuthTokens | null {
  const stored = parseJson(raw);
  if (!isJsonObject(stored) || !isJsonObject(stored.claudeAiOauth)) return null;

  const { accessToken, refreshToken, expiresAt } = stored.claudeAiOauth;
  if (!isJsonString(accessToken) || !accessToken) return null;
  if (!isJsonString(refreshToken) || !refreshToken) return null;
  return {
    access: accessToken,
    refresh: refreshToken,
    expires: isJsonNumber(expiresAt) ? expiresAt : 0,
  };
}

async function readKeychainEntry(account?: string): Promise<string | null> {
  const args = ["find-generic-password", "-s", keychainService];
  if (account) args.push("-a", account);
  args.push("-w");
  try {
    const { stdout } = await execFileAsync("security", args);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function readKeychainCredentials(): Promise<string | null> {
  const user = process.env.USER;
  return (
    (user ? await readKeychainEntry(user) : null) ??
    (await readKeychainEntry("Claude Code")) ??
    (await readKeychainEntry())
  );
}

async function readCredentialFile(path: string): Promise<OAuthTokens | null> {
  try {
    return parseCredentialJson(await readFile(path, "utf-8"));
  } catch (failure) {
    log.debug("failed to read credential file", { path, error: String(failure) });
    return null;
  }
}

export async function readClaudeCodeCredentials(): Promise<OAuthTokens | null> {
  if (!isMac) return readCredentialFile(claudeCredentialsPath());

  const raw = await readKeychainCredentials();
  return raw ? parseCredentialJson(raw) : null;
}

export function readCCSCredentials(instance: CCSInstance): Promise<OAuthTokens | null> {
  return readCredentialFile(instance.credentialsPath);
}

export async function refreshViaClaudeCli(): Promise<OAuthTokens | null> {
  log.info("triggering claude cli refresh");
  try {
    await execFileAsync(claudeCommand, ["--print", "--model", "haiku", "ping"], {
      timeout: 30_000,
      env: { ...process.env, TERM: "dumb" },
    });
  } catch (failure) {
    log.warn("claude cli refresh command failed", { error: String(failure) });
  }
  return readClaudeCodeCredentials();
}

export async function hasClaude(): Promise<boolean> {
  return (await findClaudeBinary()) !== null;
}

async function hasFile(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function discoverCCSInstances(): Promise<CCSInstance[]> {
  const directory = ccsInstancesDirectory();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      credentialsPath: join(directory, entry.name, ".credentials.json"),
    }));
  const present = await Promise.all(
    candidates.map((candidate) => hasFile(candidate.credentialsPath)),
  );
  const instances = candidates.filter((_candidate, index) => present[index]);
  log.info("discovered ccs instances", { count: instances.length });
  return instances;
}

export async function readFreshCliCredentials(): Promise<OAuthTokens | null> {
  const stored = await readClaudeCodeCredentials();
  if (stored && !isExpiringSoon(stored.expires)) return stored;

  const triggered = await refreshViaClaudeCli();
  return triggered && !isExpiringSoon(triggered.expires) ? triggered : null;
}

async function freshOrRefreshed(
  stored: OAuthTokens | null,
  source: string,
): Promise<OAuthTokens | null> {
  if (!stored) return null;
  if (!isExpiringSoon(stored.expires)) return stored;

  try {
    return await refreshTokensOnce(stored.refresh);
  } catch (failure) {
    log.warn("stored credential refresh failed", { source, error: String(failure) });
    return null;
  }
}

export async function resolveCliTokens(): Promise<OAuthTokens | null> {
  const stored = await readClaudeCodeCredentials();
  if (!stored) return null;

  const refreshed = await freshOrRefreshed(stored, "claude-cli");
  if (refreshed) return refreshed;

  const triggered = await refreshViaClaudeCli();
  return triggered && !isExpiringSoon(triggered.expires) ? triggered : null;
}

export async function resolveCcsTokens(instance: CCSInstance): Promise<OAuthTokens | null> {
  return freshOrRefreshed(await readCCSCredentials(instance), `ccs:${instance.name}`);
}

function isUsableAlternate(tokens: OAuthTokens | null, currentRefresh: string): boolean {
  return tokens !== null && tokens.refresh !== currentRefresh && !isExpiringSoon(tokens.expires);
}

export async function findAlternateCredentials(
  currentRefresh: string,
): Promise<OAuthTokens | null> {
  const cli = await readClaudeCodeCredentials();
  if (isUsableAlternate(cli, currentRefresh)) {
    log.info("found alternate credentials from claude cli");
    return cli;
  }

  const instances = await discoverCCSInstances();
  const stored = await Promise.all(instances.map(readCCSCredentials));
  const index = stored.findIndex((tokens) => isUsableAlternate(tokens, currentRefresh));
  if (index === -1) return null;

  log.info("found alternate credentials from ccs instance", { instance: instances[index].name });
  return stored[index];
}
