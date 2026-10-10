import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "anthropic-login-test-"));
const stubBin = join(sandbox, "bin");
const toolBin = join(sandbox, "tools");
mkdirSync(stubBin, { recursive: true });
mkdirSync(toolBin, { recursive: true });

const hostWhich = execFileSync("sh", ["-c", "command -v which"], { encoding: "utf-8" }).trim();
symlinkSync(hostWhich, join(toolBin, "which"));

process.env.TEST_HOST_PATH = process.env.PATH;
process.env.CLAUDE_AUTH_DEBUG = "0";
process.env.HOME = sandbox;
process.env.TEST_SANDBOX_HOME = sandbox;
process.env.USER = "fixture-user";
process.env.PATH = `${stubBin}:${toolBin}`;
process.env.TEST_STUB_BIN = stubBin;

function isLocal(input: RequestInfo | URL): boolean {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

function guarded(hostFetch: typeof fetch): typeof fetch {
  return Object.assign(
    async (input: RequestInfo | URL, init?: BunFetchRequestInit) => {
      if (isLocal(input)) return hostFetch(input, init);
      const url = new URL(input instanceof Request ? input.url : input.toString());
      throw new Error(`unexpected network request in tests: ${url.origin}${url.pathname}`);
    },
    { preconnect: hostFetch.preconnect },
  );
}

globalThis.fetch = guarded(globalThis.fetch);
