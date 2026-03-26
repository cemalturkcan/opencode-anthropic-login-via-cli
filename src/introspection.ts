import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  IS_WIN,
  CLAUDE_CMD,
  DEFAULT_VERSION,
  DEFAULT_SCOPES,
  type IntrospectionResult,
} from "./constants.ts";
import { log } from "./logger.ts";
import { BASE_BETAS } from "./model-config.ts";

const execFileAsync = promisify(execFile);

// ── Known Beta Prefixes ──────────────────────────────────────────────────────
// Used to filter binary scan results to only known Anthropic beta headers.

const KNOWN_BETA_PREFIXES = [
  "claude-code-",
  "interleaved-thinking-",
  "context-management-",
  "oauth-",
  "prompt-caching-scope-",
  "context-1m-",
  "effort-",
];

// ── Stream Scanner (Windows) ─────────────────────────────────────────────────
// Scans a binary file in 256KB chunks to extract regex matches without loading
// the entire file into memory. Uses latin1 encoding (1:1 byte->char mapping)
// to safely handle binary content while matching ASCII-only patterns.

const SCAN_CHUNK_SIZE = 256 * 1024;
const SCAN_OVERLAP = 128;

async function streamScanBinary(binaryPath: string, patterns: RegExp[]): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const results: Set<string>[] = patterns.map(() => new Set());
    let tail = "";

    const stream = createReadStream(binaryPath, {
      highWaterMark: SCAN_CHUNK_SIZE,
    });

    stream.on("data", (chunk: Buffer) => {
      const raw = chunk.toString("latin1");
      const text = tail + raw;
      for (let i = 0; i < patterns.length; i++) {
        const flags = patterns[i].flags.includes("g") ? patterns[i].flags : `${patterns[i].flags}g`;
        const re = new RegExp(patterns[i].source, flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          results[i].add(m[0]);
        }
      }
      // Fix: use `text` for overlap instead of `raw` to preserve boundary context
      tail = text.length > SCAN_OVERLAP ? text.slice(-SCAN_OVERLAP) : text;
    });

    stream.on("end", () => resolve(results.map((s) => [...s])));
    stream.on("error", reject);
  });
}

// ── Binary Discovery ─────────────────────────────────────────────────────────

export async function findClaudeBinary(): Promise<string | null> {
  if (IS_WIN) {
    const candidates = [
      join(homedir(), ".claude", "local", "claude.exe"),
      join(homedir(), "AppData", "Local", "Programs", "claude-code", "claude.exe"),
    ];
    for (const p of candidates) {
      try {
        await access(p);
        return p;
      } catch {
        // Continue to next candidate
      }
    }
    try {
      const { stdout } = await execFileAsync("where", ["claude"], {
        timeout: 3000,
      });
      const first = stdout.trim().split(/\r?\n/)[0];
      if (first) return first.trim();
    } catch {
      log.debug("Could not find claude.exe via 'where'");
    }
    return null;
  }

  // Unix
  try {
    const { stdout } = await execFileAsync("which", ["claude"], {
      timeout: 3000,
    });
    return stdout.trim() || null;
  } catch {
    log.debug("Could not find claude via 'which'");
    return null;
  }
}

// ── Beta/Scope Extraction ────────────────────────────────────────────────────
// Improved regex: supports multi-segment beta names (e.g. prompt-caching-scope-2026-01-05)

const BETA_RE =
  /(?<![a-z0-9-])(?:claude-code-\d{8}|[a-z0-9]+(?:-[a-z0-9]+)*-20\d{2}-\d{2}-\d{2})(?![a-z0-9-])/g;

// Improved scope regex: supports digits and hyphens in scope names
const SCOPE_RE = /(?:user|org):[a-z0-9:_-]+/g;

async function extractFromBinaryWin(
  binaryPath: string,
): Promise<{ betaHeaders: string[] | null; scopes: string | null }> {
  const [betaMatches, scopeMatches] = await streamScanBinary(binaryPath, [BETA_RE, SCOPE_RE]);

  const betaHeaders = betaMatches.filter((h) => KNOWN_BETA_PREFIXES.some((p) => h.startsWith(p)));
  if (!betaHeaders.some((h) => h.startsWith("oauth-"))) {
    betaHeaders.push("oauth-2025-04-20");
  }

  const scopes = scopeMatches.filter(
    (s) =>
      !s.includes("this") && !s.endsWith(":") && (s.startsWith("user:") || s.startsWith("org:")),
  );

  return {
    betaHeaders: betaHeaders.length > 0 ? betaHeaders : null,
    scopes: scopes.length > 0 ? scopes.join(" ") : null,
  };
}

async function extractBetaHeadersUnix(binaryPath: string): Promise<string[] | null> {
  try {
    const shellSafe = binaryPath.replace(/'/g, "'\\''");
    const { stdout } = await execFileAsync(
      "sh",
      [
        "-c",
        // Improved regex: supports multi-segment beta names
        `strings '${shellSafe}' | grep -oE '[a-z0-9]+(-[a-z0-9]+)*-20[0-9]{2}-[0-9]{2}-[0-9]{2}|claude-code-[0-9]+' | sort -u`,
      ],
      { timeout: 30_000 },
    );
    const headers = stdout
      .trim()
      .split("\n")
      .filter((h) => h && KNOWN_BETA_PREFIXES.some((p) => h.startsWith(p)));
    if (!headers.some((h) => h.startsWith("oauth-"))) {
      headers.push("oauth-2025-04-20");
    }
    log.debug("Extracted beta headers from binary", { headers });
    return headers.length > 0 ? headers : null;
  } catch (e) {
    log.warn("Failed to extract beta headers from binary", {
      error: String(e),
    });
    return null;
  }
}

async function extractScopesUnix(binaryPath: string): Promise<string | null> {
  try {
    const shellSafe = binaryPath.replace(/'/g, "'\\''");
    const { stdout } = await execFileAsync(
      "sh",
      [
        "-c",
        // Improved regex: supports digits and hyphens in scope names
        `strings '${shellSafe}' | grep -oE '(user|org):[a-z0-9:_-]+' | sort -u`,
      ],
      { timeout: 30_000 },
    );
    const scopes = stdout
      .trim()
      .split("\n")
      .filter(
        (s) =>
          s &&
          !s.includes("this") &&
          !s.endsWith(":") &&
          (s.startsWith("user:") || s.startsWith("org:")),
      );
    log.debug("Extracted scopes from binary", { scopes });
    return scopes.length > 0 ? scopes.join(" ") : null;
  } catch (e) {
    log.warn("Failed to extract scopes from binary", { error: String(e) });
    return null;
  }
}

// ── Version Parsing ──────────────────────────────────────────────────────────

function parseVersion(output: string): string {
  // Robust: find semver pattern regardless of prefix text like "Claude Code 2.1.80"
  const match = output.match(/\b(\d+\.\d+\.\d+(?:[-+][^\s]+)?)\b/);
  return match?.[1] ?? DEFAULT_VERSION;
}

// ── Main Introspection ───────────────────────────────────────────────────────

async function introspectClaudeBinary(): Promise<IntrospectionResult | null> {
  try {
    const { stdout: versionOut } = await execFileAsync(CLAUDE_CMD, ["--version"], {
      timeout: 5000,
    });
    const version = parseVersion(versionOut);
    log.info("Claude CLI version detected", { version });

    const binaryPath = await findClaudeBinary();
    if (!binaryPath) {
      log.info("Binary not found on disk, using static defaults");
      return {
        version,
        userAgent: `claude-cli/${version} (external, cli)`,
        betaHeaders: BASE_BETAS,
        scopes: DEFAULT_SCOPES,
      };
    }

    let betaHeaders: string[] | null;
    let scopes: string | null;

    if (IS_WIN) {
      const extracted = await extractFromBinaryWin(binaryPath);
      betaHeaders = extracted.betaHeaders;
      scopes = extracted.scopes;
    } else {
      [betaHeaders, scopes] = await Promise.all([
        extractBetaHeadersUnix(binaryPath),
        extractScopesUnix(binaryPath),
      ]);
    }

    const result: IntrospectionResult = {
      version,
      userAgent: `claude-cli/${version} (external, cli)`,
      betaHeaders: betaHeaders ?? BASE_BETAS,
      scopes: scopes ?? DEFAULT_SCOPES,
    };
    log.info("Introspection complete", {
      version,
      betaCount: result.betaHeaders.length,
      betas: result.betaHeaders,
    });
    return result;
  } catch (e) {
    log.error("Introspection failed", { error: String(e) });
    return null;
  }
}

// ── Lazy Introspection ──────────────────────────────────────────────────────
// Starts in background during plugin init. Uses safe defaults until complete.

let _intro: IntrospectionResult = {
  version: DEFAULT_VERSION,
  userAgent: `claude-cli/${DEFAULT_VERSION} (external, cli)`,
  betaHeaders: BASE_BETAS,
  scopes: DEFAULT_SCOPES,
};
let _introPromise: Promise<void> | null = null;

/** Non-blocking — returns current values (defaults or introspected) */
export function getIntro(): IntrospectionResult {
  return _intro;
}

/** Blocking — waits for introspection to finish, then returns final values */
export async function awaitIntro(): Promise<IntrospectionResult> {
  if (_introPromise) await _introPromise;
  return _intro;
}

/** Fire-and-forget — call once at plugin init */
export function startIntro(): void {
  _introPromise = introspectClaudeBinary()
    .then((result) => {
      if (result) _intro = result;
    })
    .catch((e) => {
      log.error("Background introspection failed", { error: String(e) });
    })
    .finally(() => {
      _introPromise = null;
    });
}
