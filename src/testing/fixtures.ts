import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CCSInstance } from "../shared/credentials.ts";
import { ccsInstancesDirectory, claudeCredentialsPath, homeDirectory } from "../shared/paths.ts";

export type StoredTokens = { access: string; refresh: string; expiresAt: number };

const hour = 60 * 60 * 1000;

export function validTokens(prefix: string): StoredTokens {
  return { access: `${prefix}-access`, refresh: `${prefix}-refresh`, expiresAt: Date.now() + hour };
}

export function expiredTokens(prefix: string): StoredTokens {
  return { access: `${prefix}-access`, refresh: `${prefix}-refresh`, expiresAt: 0 };
}

function stubBin(): string {
  const directory = process.env.TEST_STUB_BIN;
  if (!directory) throw new Error("TEST_STUB_BIN is not set; is the test preload configured?");
  return directory;
}

function credentialJson(tokens: StoredTokens): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: tokens.access,
      refreshToken: tokens.refresh,
      expiresAt: tokens.expiresAt,
    },
  });
}

async function writeExecutable(name: string, script: string): Promise<void> {
  const path = join(stubBin(), name);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

export async function writeCliCredentials(tokens: StoredTokens): Promise<void> {
  const path = claudeCredentialsPath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, credentialJson(tokens));
  await writeExecutable("security", `/bin/cat "${path}"`);
}

export async function installClaudeStub(onRun?: StoredTokens): Promise<void> {
  const refresh = onRun
    ? `printf '%s' '${credentialJson(onRun)}' > "${claudeCredentialsPath()}"`
    : "true";
  await writeExecutable("claude", `${refresh}\nexit 0`);
}

export async function installClaudeBinary(version: string): Promise<void> {
  await writeExecutable(
    "claude",
    `if [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; fi\nexit 0`,
  );
}

export async function writeCcsInstance(name: string, tokens: StoredTokens): Promise<CCSInstance> {
  const directory = join(ccsInstancesDirectory(), name);
  await mkdir(directory, { recursive: true });
  const credentialsPath = join(directory, ".credentials.json");
  await writeFile(credentialsPath, credentialJson(tokens));
  return { name, credentialsPath };
}

export async function resetSandbox(): Promise<void> {
  await rm(join(homeDirectory(), ".claude"), { recursive: true, force: true });
  await rm(join(homeDirectory(), ".ccs"), { recursive: true, force: true });
  await rm(stubBin(), { recursive: true, force: true });
  await mkdir(stubBin(), { recursive: true });
}
