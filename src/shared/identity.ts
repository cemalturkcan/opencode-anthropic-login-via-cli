import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { getIntro } from "./introspection.ts";
import { isJsonObject, isJsonString, parseJson, type JsonValue } from "./json.ts";
import { log } from "./logger.ts";
import { claudeConfigPath } from "./paths.ts";

export type AccountProfile = { uuid: string; email: string };

const profileUrl = "https://api.anthropic.com/api/oauth/profile";
const claudeUserId = /^[0-9a-f]{64}$/;
const maxCachedProfiles = 16;

let cachedDeviceId: Promise<string> | null = null;
const profiles = new Map<string, Promise<AccountProfile | null>>();

export function resetIdentityCache(): void {
  cachedDeviceId = null;
  profiles.clear();
}

async function claudeCodeUserId(): Promise<string | null> {
  try {
    const config = parseJson(await readFile(claudeConfigPath(), "utf-8"));
    if (!isJsonObject(config) || !isJsonString(config.userID)) return null;
    return claudeUserId.test(config.userID) ? config.userID : null;
  } catch {
    return null;
  }
}

function derivedDeviceId(): string {
  return createHash("sha256").update(`${hostname()}:${userInfo().username}`).digest("hex");
}

export function deviceId(): Promise<string> {
  cachedDeviceId ??= claudeCodeUserId().then((userId) => userId ?? derivedDeviceId());
  return cachedDeviceId;
}

function parseProfile(body: JsonValue): AccountProfile | null {
  if (!isJsonObject(body) || !isJsonObject(body.account)) return null;
  const { uuid, email } = body.account;
  return isJsonString(uuid) && isJsonString(email) ? { uuid, email } : null;
}

async function fetchProfile(access: string): Promise<AccountProfile | null> {
  try {
    const response = await fetch(profileUrl, {
      headers: {
        authorization: `Bearer ${access}`,
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": getIntro().userAgent,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log.warn("oauth profile request failed", { status: response.status });
      return null;
    }
    return parseProfile(await response.json());
  } catch (failure) {
    log.warn("oauth profile request failed", { error: String(failure) });
    return null;
  }
}

export function accountProfile(access: string): Promise<AccountProfile | null> {
  const cached = profiles.get(access);
  if (cached) return cached;

  if (profiles.size >= maxCachedProfiles) profiles.clear();
  const profile = fetchProfile(access).then((result) => {
    if (!result) profiles.delete(access);
    return result;
  });
  profiles.set(access, profile);
  return profile;
}
