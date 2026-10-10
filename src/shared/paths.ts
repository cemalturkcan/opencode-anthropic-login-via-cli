import { homedir } from "node:os";
import { join } from "node:path";
import { isWindows } from "./constants.ts";

export function homeDirectory(): string {
  if (isWindows) return homedir();
  return process.env.HOME || homedir();
}

export function claudeCredentialsPath(): string {
  return join(homeDirectory(), ".claude", ".credentials.json");
}

export function claudeConfigPath(): string {
  return join(homeDirectory(), ".claude.json");
}

export function ccsInstancesDirectory(): string {
  return join(homeDirectory(), ".ccs", "instances");
}

export function debugLogPath(): string {
  return join(homeDirectory(), ".local", "share", "opencode", "claude-auth-debug.log");
}
