import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "anthropic-login-test-"));
const stubBin = join(sandbox, "bin");
mkdirSync(stubBin, { recursive: true });

process.env.TEST_HOST_PATH = process.env.PATH;
process.env.CLAUDE_AUTH_DEBUG = "0";
process.env.HOME = sandbox;
process.env.USER = "fixture-user";
process.env.PATH = `${stubBin}:/usr/bin:/bin`;
process.env.TEST_STUB_BIN = stubBin;
