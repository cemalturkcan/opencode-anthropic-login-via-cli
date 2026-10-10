import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { debugLogPath } from "./paths.ts";

type LogLevel = "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null | undefined | LogValue[] | LogFields;
export type LogFields = { [key: string]: LogValue };

const sensitiveKeyFragments = ["token", "secret", "password", "key"];
const sensitiveKeys = new Set(["access", "refresh", "authorization"]);

export function isDebugEnabled(): boolean {
  const setting = process.env.CLAUDE_AUTH_DEBUG;
  return setting !== "0" && setting !== "false";
}

function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return sensitiveKeys.has(lowered) || sensitiveKeyFragments.some((part) => lowered.includes(part));
}

function redactString(value: string): string {
  if (value.startsWith("eyJ") && value.length > 40) return `${value.slice(0, 10)}...[REDACTED]`;
  if (value.length > 20 && /^[A-Za-z0-9_-]+$/.test(value))
    return `${value.slice(0, 8)}...[REDACTED]`;
  return value;
}

function isText(value: LogValue): value is string {
  return typeof value === "string";
}

function isFields(value: LogValue): value is LogFields {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactSensitive(value: LogValue): string {
  return isText(value) ? `${value.slice(0, 8)}...[REDACTED]` : "[REDACTED]";
}

export function redact(value: LogValue): LogValue {
  if (isText(value)) return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (!isFields(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      isSensitiveKey(key) ? redactSensitive(field) : redact(field),
    ]),
  );
}

let logDirectoryReady = false;

async function writeLog(level: LogLevel, message: string, fields?: LogFields): Promise<void> {
  if (!isDebugEnabled()) return;

  const path = debugLogPath();
  const entry = { ts: new Date().toISOString(), level, msg: message };
  const line = JSON.stringify(fields ? { ...entry, data: redact(fields) } : entry);

  try {
    if (!logDirectoryReady) {
      await mkdir(dirname(path), { recursive: true });
      logDirectoryReady = true;
    }
    await appendFile(path, `${line}\n`);
  } catch {}
}

export const log = {
  debug: (message: string, fields?: LogFields) => writeLog("debug", message, fields),
  info: (message: string, fields?: LogFields) => writeLog("info", message, fields),
  warn: (message: string, fields?: LogFields) => writeLog("warn", message, fields),
  error: (message: string, fields?: LogFields) => writeLog("error", message, fields),
};
