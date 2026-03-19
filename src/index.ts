import type { Plugin } from "@opencode-ai/plugin";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ClaudeCredentials = {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: string | number;
    subscriptionType?: string;
  };
};

type OpenCodeAuth = Record<
  string,
  { type: string; key?: string; [k: string]: unknown }
>;

function credentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

function authJsonPath(): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "opencode", "auth.json");
}

async function readJson<T>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(p, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

async function hasClaude(): Promise<boolean> {
  try {
    await execFileAsync("which", ["claude"]);
    return true;
  } catch {
    return false;
  }
}

async function refreshViaCli(): Promise<void> {
  try {
    await execFileAsync(
      "claude",
      ["-p", ".", "--model", "claude-haiku-4-5-20250514"],
      { timeout: 60_000, env: { ...process.env, TERM: "dumb" } },
    );
  } catch {}
}

const REFRESH_THRESHOLD_MS = 30 * 60 * 1000;

const plugin: Plugin = async () => {
  const cli = await hasClaude();
  const creds = await readJson<ClaudeCredentials>(credentialsPath());

  if (!cli || !creds?.claudeAiOauth?.accessToken) {
    return {};
  }

  let cachedToken: string | undefined;
  let cachedExpiresAt: number | undefined;
  let syncPromise: Promise<void> | null = null;

  async function doSync(): Promise<void> {
    const creds = await readJson<ClaudeCredentials>(credentialsPath());
    let access = creds?.claudeAiOauth?.accessToken;
    let exp = creds?.claudeAiOauth?.expiresAt;

    if (!access) return;

    const remaining = exp ? Number(exp) - Date.now() : Infinity;

    if (remaining < 5 * 60 * 1000) {
      await refreshViaCli();
      const fresh = await readJson<ClaudeCredentials>(credentialsPath());
      if (fresh?.claudeAiOauth?.accessToken) {
        access = fresh.claudeAiOauth.accessToken;
        exp = fresh.claudeAiOauth.expiresAt;
      }
    }

    cachedToken = access;
    cachedExpiresAt = exp ? Number(exp) : undefined;

    try {
      const auth = (await readJson<OpenCodeAuth>(authJsonPath())) ?? {};
      if (auth.anthropic?.key !== cachedToken) {
        auth.anthropic = {
          ...(auth.anthropic ?? {}),
          type: "api",
          key: cachedToken!,
        };
        await writeFile(authJsonPath(), JSON.stringify(auth, null, 2), "utf-8");
      }
    } catch {}
  }

  function ensureSync(): Promise<void> {
    if (!syncPromise) {
      syncPromise = doSync().finally(() => {
        syncPromise = null;
      });
    }
    return syncPromise;
  }

  return {
    config: async (config: any): Promise<void> => {
      const providers = config.provider ?? {};
      if (!providers.anthropic) {
        providers.anthropic = { options: { apiKey: "cli-managed" } };
        config.provider = providers;
      }
    },

    "session.created": async (): Promise<void> => {
      try {
        await ensureSync();
      } catch {}
    },

    "chat.headers": async (input: any, output: any): Promise<void> => {
      try {
        if (input?.model?.providerID !== "anthropic") return;

        const now = Date.now();

        if (cachedToken && cachedExpiresAt && cachedExpiresAt > now) {
          output.headers["x-api-key"] = cachedToken;
          if (cachedExpiresAt - now < REFRESH_THRESHOLD_MS && !syncPromise) {
            ensureSync();
          }
          return;
        }

        if (syncPromise) {
          await syncPromise;
          if (cachedToken) output.headers["x-api-key"] = cachedToken;
          return;
        }

        const creds = await readJson<ClaudeCredentials>(credentialsPath());
        const access = creds?.claudeAiOauth?.accessToken;
        const exp = creds?.claudeAiOauth?.expiresAt
          ? Number(creds.claudeAiOauth.expiresAt)
          : undefined;

        if (access && exp && exp > now) {
          cachedToken = access;
          cachedExpiresAt = exp;
          output.headers["x-api-key"] = access;
          return;
        }

        await ensureSync();
        if (cachedToken) output.headers["x-api-key"] = cachedToken;
      } catch {}
    },
  };
};

export default plugin;
