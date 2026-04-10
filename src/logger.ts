import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const DEBUG = process.env.CLAUDE_AUTH_DEBUG !== "0" && process.env.CLAUDE_AUTH_DEBUG !== "false";

const LOG_DIR = join(homedir(), ".local", "share", "opencode");
const LOG_FILE = join(LOG_DIR, "claude-auth-debug.log");

let logDirReady = false;

type LogLevel = "debug" | "info" | "warn" | "error";

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("eyJ") && value.length > 40) {
      return `${value.slice(0, 10)}...[REDACTED]`;
    }
    if (value.length > 20 && /^[A-Za-z0-9_-]+$/.test(value)) {
      return `${value.slice(0, 8)}...[REDACTED]`;
    }
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const keyLower = k.toLowerCase();
      if (
        keyLower.includes("token") ||
        keyLower.includes("secret") ||
        keyLower.includes("password") ||
        keyLower.includes("key") ||
        keyLower === "access" ||
        keyLower === "refresh" ||
        keyLower === "authorization"
      ) {
        redacted[k] = typeof v === "string" ? `${v.slice(0, 8)}...[REDACTED]` : "[REDACTED]";
      } else {
        redacted[k] = redact(v);
      }
    }
    return redacted;
  }
  return value;
}

async function writeLog(level: LogLevel, msg: string, data?: Record<string, unknown>) {
  if (!DEBUG) return;

  try {
    if (!logDirReady) {
      await mkdir(LOG_DIR, { recursive: true });
      logDirReady = true;
    }

    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(data ? { data: redact(data) } : {}),
    };

    await appendFile(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // logging must never break the plugin
  }
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => writeLog("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => writeLog("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => writeLog("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => writeLog("error", msg, data),
  enabled: DEBUG,
};
