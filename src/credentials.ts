import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import {
  IS_WIN,
  CLAUDE_CMD,
  REFRESH_BUFFER_MS,
  CLIENT_ID,
  TOKEN_URL,
  type OAuthTokens,
} from "./constants.ts";
import { log } from "./logger.ts";
import { fetchWithRetry } from "./http.ts";
import { getIntro } from "./introspection.ts";

const execFileAsync = promisify(execFile);

// ── Mutable State ────────────────────────────────────────────────────────────

let currentRefreshToken: string | null = null;
let refreshInFlight: Promise<OAuthTokens> | null = null;

export function getCurrentRefreshToken(): string | null {
  return currentRefreshToken;
}

export function setCurrentRefreshToken(token: string | null): void {
  currentRefreshToken = token;
}

export function resetRefreshState(): void {
  refreshInFlight = null;
  currentRefreshToken = null;
}

export function clearRefreshInFlight(): void {
  refreshInFlight = null;
}

// ── Token Refresh ────────────────────────────────────────────────────────────

async function refreshTokens(refreshToken: string): Promise<OAuthTokens> {
  const { userAgent } = getIntro();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  log.info("Refreshing OAuth token");

  const res = await fetchWithRetry(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    log.error("Token refresh failed", {
      status: res.status,
      statusText: res.statusText,
    });
    throw new Error(
      `Token refresh failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  log.info("Token refresh successful", { expiresIn: data.expires_in });

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

export function refreshTokensSafe(refreshToken: string): Promise<OAuthTokens> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshTokens(refreshToken).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// ── Credential Parsing ───────────────────────────────────────────────────────

export function parseCredentialJson(raw: string): OAuthTokens | null {
  try {
    const creds = JSON.parse(raw) as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
      };
    };
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken) return null;
    return {
      access: oauth.accessToken,
      refresh: oauth.refreshToken,
      expires: oauth.expiresAt ?? 0,
    };
  } catch {
    return null;
  }
}

// ── Keychain (macOS) ─────────────────────────────────────────────────────────

export async function readKeychainEntry(account?: string): Promise<string | null> {
  try {
    const args = ["find-generic-password", "-s", "Claude Code-credentials"];
    if (account) args.push("-a", account);
    args.push("-w");
    const { stdout } = await execFileAsync("security", args);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function readClaudeCodeCredentials(): Promise<OAuthTokens | null> {
  try {
    let raw: string | null = null;
    if (platform() === "darwin") {
      const user = process.env.USER || "";
      if (user) raw = await readKeychainEntry(user);
      if (!raw) raw = await readKeychainEntry("Claude Code");
      if (!raw) raw = await readKeychainEntry();
    } else {
      raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf-8");
    }
    if (!raw) return null;
    return parseCredentialJson(raw);
  } catch (e) {
    log.debug("Failed to read Claude Code credentials", {
      error: String(e),
    });
    return null;
  }
}

export async function refreshViaClaudeCli(): Promise<OAuthTokens | null> {
  try {
    log.info("Triggering Claude CLI refresh");
    await execFileAsync(CLAUDE_CMD, ["--print", "--model", "claude-haiku-4", "ping"], {
      timeout: 30_000,
      env: { ...process.env, TERM: "dumb" },
    });
  } catch (e) {
    log.warn("Claude CLI refresh command failed", { error: String(e) });
  }
  return readClaudeCodeCredentials();
}

// ── Utilities ────────────────────────────────────────────────────────────────

export function isExpiringSoon(expiresAt: number): boolean {
  return Date.now() + REFRESH_BUFFER_MS >= expiresAt;
}

export async function hasClaude(): Promise<boolean> {
  try {
    const cmd = IS_WIN ? "where" : "which";
    await execFileAsync(cmd, [CLAUDE_CMD], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ── CCS Multi-Instance ───────────────────────────────────────────────────────

export type CCSInstance = { name: string; credentialsPath: string };

export async function discoverCCSInstances(): Promise<CCSInstance[]> {
  const ccsDir = join(homedir(), ".ccs", "instances");
  try {
    const entries = await readdir(ccsDir, { withFileTypes: true });
    const instances: CCSInstance[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const credPath = join(ccsDir, entry.name, ".credentials.json");
      try {
        await access(credPath);
        instances.push({ name: entry.name, credentialsPath: credPath });
      } catch {
        // Credential file doesn't exist for this instance
      }
    }
    log.debug("Discovered CCS instances", { count: instances.length });
    return instances;
  } catch {
    return [];
  }
}

export async function readCCSCredentials(credentialsPath: string): Promise<OAuthTokens | null> {
  try {
    const raw = await readFile(credentialsPath, "utf-8");
    if (!raw) return null;
    return parseCredentialJson(raw);
  } catch {
    return null;
  }
}

// ── Alternate Credential Discovery ───────────────────────────────────────────

export async function findAlternateCredentials(
  currentRefresh: string,
): Promise<OAuthTokens | null> {
  const main = await readClaudeCodeCredentials();
  if (main && main.refresh !== currentRefresh && !isExpiringSoon(main.expires)) {
    log.info("Found alternate credentials from main CLI");
    return main;
  }

  const instances = await discoverCCSInstances();
  for (const inst of instances) {
    const creds = await readCCSCredentials(inst.credentialsPath);
    if (creds && creds.refresh !== currentRefresh && !isExpiringSoon(creds.expires)) {
      log.info("Found alternate credentials from CCS instance", {
        instance: inst.name,
      });
      return creds;
    }
  }

  return null;
}
