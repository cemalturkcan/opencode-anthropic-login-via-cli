import type { Plugin } from "@opencode-ai/plugin";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readdir, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────────────

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const TOOL_PREFIX = "mcp_";

const DEFAULT_VERSION = "2.1.80";
const DEFAULT_SCOPES =
  "org:create_api_key user:file_upload user:inference user:mcp_servers user:profile user:sessions:claude_code";
const DEFAULT_BETA_HEADERS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "oauth-2025-04-20",
];

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────────────

type OAuthTokens = { access: string; refresh: string; expires: number };

type IntrospectionResult = {
  version: string;
  userAgent: string;
  betaHeaders: string[];
  scopes: string;
};

// ── Binary Introspection ─────────────────────────────────────────────────────
// Reads version, beta headers, and scopes directly from the Claude CLI binary
// to stay in sync with Anthropic API requirements without hardcoding values.

const KNOWN_BETA_PREFIXES = [
  "claude-code-",
  "interleaved-thinking-",
  "context-management-",
  "oauth-",
];

const IS_WIN = platform() === "win32";
const CLAUDE_CMD = IS_WIN ? "claude.exe" : "claude";

// ── Stream Scanner (Windows) ─────────────────────────────────────────────────
// Scans a binary file in 256KB chunks to extract regex matches without loading
// the entire file into memory. Uses latin1 encoding (1:1 byte→char mapping)
// to safely handle binary content while matching ASCII-only patterns.
// Peak memory: ~256KB + overlap, vs 500MB+ with readFile().toString().

const SCAN_CHUNK_SIZE = 256 * 1024;
const SCAN_OVERLAP = 128; // bytes kept between chunks for boundary matches

async function streamScanBinary(
  binaryPath: string,
  patterns: RegExp[],
): Promise<string[][]> {
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
        // Ensure global flag so exec() advances lastIndex (prevents infinite loop)
        const flags = patterns[i].flags.includes("g")
          ? patterns[i].flags
          : patterns[i].flags + "g";
        const re = new RegExp(patterns[i].source, flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          results[i].add(m[0]);
        }
      }
      tail = raw.length > SCAN_OVERLAP ? raw.slice(-SCAN_OVERLAP) : raw;
    });

    stream.on("end", () => resolve(results.map((s) => [...s])));
    stream.on("error", reject);
  });
}

async function findClaudeBinary(): Promise<string | null> {
  if (IS_WIN) {
    // Check common Windows install paths first
    const candidates = [
      join(homedir(), ".claude", "local", "claude.exe"),
      join(
        homedir(),
        "AppData",
        "Local",
        "Programs",
        "claude-code",
        "claude.exe",
      ),
    ];
    for (const p of candidates) {
      try {
        await access(p);
        return p;
      } catch {}
    }
    // Fallback to PATH
    try {
      const { stdout } = await execFileAsync("where", ["claude"], {
        timeout: 3000,
      });
      const first = stdout.trim().split(/\r?\n/)[0];
      if (first) return first.trim();
    } catch {}
    return null;
  }
  // Unix
  try {
    const { stdout } = await execFileAsync("which", ["claude"], {
      timeout: 3000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Windows: single-pass streaming scan for both beta headers and scopes
async function extractFromBinaryWin(
  binaryPath: string,
): Promise<{ betaHeaders: string[] | null; scopes: string | null }> {
  const BETA_RE = /[a-z]+-(?:[a-z0-9]+-)?20\d{2}-\d{2}-\d{2}|claude-code-\d+/g;
  const SCOPE_RE = /(?:user|org):[a-z_:]+/g;

  const [betaMatches, scopeMatches] = await streamScanBinary(binaryPath, [
    BETA_RE,
    SCOPE_RE,
  ]);

  const betaHeaders = betaMatches.filter((h) =>
    KNOWN_BETA_PREFIXES.some((p) => h.startsWith(p)),
  );
  if (!betaHeaders.some((h) => h.startsWith("oauth-"))) {
    betaHeaders.push("oauth-2025-04-20");
  }

  const scopes = scopeMatches.filter(
    (s) =>
      !s.includes("this") &&
      !s.endsWith(":") &&
      (s.startsWith("user:") || s.startsWith("org:")),
  );

  return {
    betaHeaders: betaHeaders.length > 0 ? betaHeaders : null,
    scopes: scopes.length > 0 ? scopes.join(" ") : null,
  };
}

// Unix: use strings + grep (OS-level streaming, no memory issue)
async function extractBetaHeadersUnix(
  binaryPath: string,
): Promise<string[] | null> {
  try {
    const shellSafe = binaryPath.replace(/'/g, "'\\''");
    const { stdout } = await execFileAsync(
      "sh",
      [
        "-c",
        `strings '${shellSafe}' | grep -oE '[a-z]+-[a-z0-9]+-20[0-9]{2}-[0-9]{2}-[0-9]{2}|[a-z]+-20[0-9]{2}-[0-9]{2}-[0-9]{2}|claude-code-[0-9]+' | sort -u`,
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
    return headers.length > 0 ? headers : null;
  } catch {
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
        `strings '${shellSafe}' | grep -oE '(user|org):[a-z_:]+' | sort -u`,
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
    return scopes.length > 0 ? scopes.join(" ") : null;
  } catch {
    return null;
  }
}

async function introspectClaudeBinary(): Promise<IntrospectionResult | null> {
  try {
    const { stdout: versionOut } = await execFileAsync(
      CLAUDE_CMD,
      ["--version"],
      { timeout: 5000 },
    );
    const version = versionOut.trim().split(" ")[0] || DEFAULT_VERSION;

    const binaryPath = await findClaudeBinary();
    if (!binaryPath) {
      // Can still return version-only result
      return {
        version,
        userAgent: `claude-cli/${version} (external, cli)`,
        betaHeaders: DEFAULT_BETA_HEADERS,
        scopes: DEFAULT_SCOPES,
      };
    }

    let betaHeaders: string[] | null;
    let scopes: string | null;

    if (IS_WIN) {
      // Single streaming pass — peak ~256KB, not 500MB+
      const extracted = await extractFromBinaryWin(binaryPath);
      betaHeaders = extracted.betaHeaders;
      scopes = extracted.scopes;
    } else {
      // Unix: OS-level streaming via strings | grep (parallel)
      [betaHeaders, scopes] = await Promise.all([
        extractBetaHeadersUnix(binaryPath),
        extractScopesUnix(binaryPath),
      ]);
    }

    return {
      version,
      userAgent: `claude-cli/${version} (external, cli)`,
      betaHeaders: betaHeaders ?? DEFAULT_BETA_HEADERS,
      scopes: scopes ?? DEFAULT_SCOPES,
    };
  } catch {
    return null;
  }
}

// ── Lazy Introspection ──────────────────────────────────────────────────────
// Starts in background during plugin init — does NOT block OpenCode startup.
// Uses safe defaults until the scan completes.
// authorize() for browser method awaits completion for accurate scopes.

let _intro: IntrospectionResult = {
  version: DEFAULT_VERSION,
  userAgent: `claude-cli/${DEFAULT_VERSION} (external, cli)`,
  betaHeaders: DEFAULT_BETA_HEADERS,
  scopes: DEFAULT_SCOPES,
};
let _introPromise: Promise<void> | null = null;

/** Non-blocking — returns current values (defaults or introspected) */
function getIntro(): IntrospectionResult {
  return _intro;
}

/** Blocking — waits for introspection to finish, then returns final values */
async function awaitIntro(): Promise<IntrospectionResult> {
  if (_introPromise) await _introPromise;
  return _intro;
}

/** Fire-and-forget — call once at plugin init */
function startIntro(): void {
  _introPromise = introspectClaudeBinary()
    .then((result) => {
      if (result) _intro = result;
    })
    .catch(() => {})
    .finally(() => {
      _introPromise = null;
    });
}

// ── Network Utilities ────────────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3,
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, init);
    if (res.status === 429 && i < retries - 1) {
      await new Promise((r) => setTimeout(r, (i + 1) * 2000));
      continue;
    }
    return res;
  }
  return fetch(url, init);
}

// ── PKCE Utilities ───────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString("base64url").replace(/=+$/, "");
}

function createAuthorizationRequest(scopes: string) {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const params = new URLSearchParams({
    code: "true",
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  return { url: `${AUTHORIZE_URL}?${params}`, verifier };
}

async function exchangeCodeForTokens(
  rawCode: string,
  verifier: string,
  userAgent: string,
): Promise<OAuthTokens> {
  const hashIdx = rawCode.indexOf("#");
  const code = (hashIdx >= 0 ? rawCode.slice(0, hashIdx) : rawCode).trim();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: verifier,
  });
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
    throw new Error(
      `Token exchange failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

// ── Token Refresh ────────────────────────────────────────────────────────────

let refreshInFlight: Promise<OAuthTokens> | null = null;

async function refreshTokens(refreshToken: string): Promise<OAuthTokens> {
  const { userAgent } = getIntro();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
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
    throw new Error(
      `Token refresh failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

function refreshTokensSafe(refreshToken: string): Promise<OAuthTokens> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshTokens(refreshToken).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// ── Credential JSON Parsing ──────────────────────────────────────────────────

function parseCredentialJson(raw: string): OAuthTokens | null {
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

// ── Claude Code Credential Reader ────────────────────────────────────────────

async function readKeychainEntry(account?: string): Promise<string | null> {
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

async function readClaudeCodeCredentials(): Promise<OAuthTokens | null> {
  try {
    let raw: string | null = null;
    if (platform() === "darwin") {
      const user = process.env.USER || "";
      if (user) raw = await readKeychainEntry(user);
      if (!raw) raw = await readKeychainEntry("Claude Code");
      if (!raw) raw = await readKeychainEntry();
    } else {
      raw = await readFile(
        join(homedir(), ".claude", ".credentials.json"),
        "utf-8",
      );
    }
    if (!raw) return null;
    return parseCredentialJson(raw);
  } catch {
    return null;
  }
}

async function refreshViaClaudeCli(): Promise<OAuthTokens | null> {
  try {
    await execFileAsync(
      CLAUDE_CMD,
      ["--print", "--model", "claude-haiku-4", "ping"],
      {
        timeout: 30_000,
        env: { ...process.env, TERM: "dumb" },
      },
    );
  } catch {}
  return readClaudeCodeCredentials();
}

function isExpiringSoon(expiresAt: number): boolean {
  return Date.now() + REFRESH_BUFFER_MS >= expiresAt;
}

async function hasClaude(): Promise<boolean> {
  try {
    const cmd = IS_WIN ? "where" : "which";
    await execFileAsync(cmd, [CLAUDE_CMD], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ── CCS (Claude Code Sessions) Multi-Instance Support ───────────────────────

type CCSInstance = { name: string; credentialsPath: string };

async function discoverCCSInstances(): Promise<CCSInstance[]> {
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
      } catch {}
    }
    return instances;
  } catch {
    return [];
  }
}

async function readCCSCredentials(
  credentialsPath: string,
): Promise<OAuthTokens | null> {
  try {
    const raw = await readFile(credentialsPath, "utf-8");
    if (!raw) return null;
    return parseCredentialJson(raw);
  } catch {
    return null;
  }
}

// ── Custom Fetch (Bearer auth + tool renaming + prompt sanitization) ─────────
// Reads userAgent/betaHeaders from getIntro() on every request so values
// auto-upgrade once background introspection completes.

function createCustomFetch(getAuth: () => Promise<any>, client: any) {
  return async (input: any, init?: any): Promise<Response> => {
    const { userAgent, betaHeaders } = getIntro();
    const auth = await getAuth();
    if (auth.type !== "oauth") return fetch(input, init);

    // Refresh proactively (before expiry) or if already expired
    if (!auth.access || auth.expires < Date.now() + REFRESH_BUFFER_MS) {
      let refreshed = false;

      // 1) Try OAuth refresh
      try {
        const fresh = await refreshTokensSafe(auth.refresh);
        await client.auth.set({
          path: { id: "anthropic" },
          body: {
            type: "oauth",
            refresh: fresh.refresh,
            access: fresh.access,
            expires: fresh.expires,
          },
        });
        auth.access = fresh.access;
        auth.refresh = fresh.refresh;
        auth.expires = fresh.expires;
        refreshed = true;
      } catch {}

      // 2) Try reading Claude CLI credentials
      if (!refreshed) {
        const kc = await readClaudeCodeCredentials();
        if (kc && !isExpiringSoon(kc.expires)) {
          await client.auth.set({
            path: { id: "anthropic" },
            body: { type: "oauth", ...kc },
          });
          auth.access = kc.access;
          auth.refresh = kc.refresh;
          auth.expires = kc.expires;
          refreshed = true;
        }
      }

      // 3) Last resort: trigger Claude CLI to refresh its own token
      if (!refreshed) {
        try {
          const kc = await refreshViaClaudeCli();
          if (kc && !isExpiringSoon(kc.expires)) {
            await client.auth.set({
              path: { id: "anthropic" },
              body: { type: "oauth", ...kc },
            });
            auth.access = kc.access;
            auth.refresh = kc.refresh;
            auth.expires = kc.expires;
          }
        } catch {}
      }
    }

    // Build headers
    const requestInit = init ?? {};
    const reqHeaders = new Headers();

    if (input instanceof Request) {
      input.headers.forEach((v: string, k: string) => reqHeaders.set(k, v));
    }
    if (requestInit.headers) {
      const h = requestInit.headers;
      if (h instanceof Headers) {
        h.forEach((v: string, k: string) => reqHeaders.set(k, v));
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) {
          if (v !== undefined) reqHeaders.set(k, String(v));
        }
      } else {
        for (const [k, v] of Object.entries(h as Record<string, string>)) {
          if (v !== undefined) reqHeaders.set(k, String(v));
        }
      }
    }

    // Merge beta headers
    const incoming = (reqHeaders.get("anthropic-beta") || "")
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    const merged = [...new Set([...betaHeaders, ...incoming])].join(",");

    reqHeaders.set("authorization", `Bearer ${auth.access}`);
    reqHeaders.set("anthropic-beta", merged);
    reqHeaders.set("user-agent", userAgent);
    reqHeaders.delete("x-api-key");

    // Transform request body
    let body = requestInit.body;
    if (body && typeof body === "string") {
      try {
        const parsed = JSON.parse(body);

        // Sanitize system prompt
        if (parsed.system && Array.isArray(parsed.system)) {
          parsed.system = parsed.system.map((item: any) => {
            if (item.type === "text" && item.text) {
              return {
                ...item,
                text: item.text
                  .replace(/OpenCode/g, "Claude Code")
                  .replace(/opencode/gi, "Claude"),
              };
            }
            return item;
          });
        }

        // Prefix tool names
        if (parsed.tools && Array.isArray(parsed.tools)) {
          parsed.tools = parsed.tools.map((t: any) => ({
            ...t,
            name: t.name ? `${TOOL_PREFIX}${t.name}` : t.name,
          }));
        }
        if (parsed.messages && Array.isArray(parsed.messages)) {
          parsed.messages = parsed.messages.map((msg: any) => {
            if (msg.content && Array.isArray(msg.content)) {
              msg.content = msg.content.map((block: any) => {
                if (block.type === "tool_use" && block.name) {
                  return { ...block, name: `${TOOL_PREFIX}${block.name}` };
                }
                return block;
              });
            }
            return msg;
          });
        }
        body = JSON.stringify(parsed);
      } catch {}
    }

    // Add ?beta=true to messages endpoint
    let reqInput = input;
    try {
      let reqUrl: URL | null = null;
      if (typeof input === "string" || input instanceof URL) {
        reqUrl = new URL(input.toString());
      } else if (input instanceof Request) {
        reqUrl = new URL(input.url);
      }
      if (
        reqUrl?.pathname === "/v1/messages" &&
        !reqUrl.searchParams.has("beta")
      ) {
        reqUrl.searchParams.set("beta", "true");
        reqInput =
          input instanceof Request
            ? new Request(reqUrl.toString(), input)
            : reqUrl;
      }
    } catch {}

    const response = await fetch(reqInput, {
      ...requestInit,
      body,
      headers: reqHeaders,
    });

    // Un-prefix tool names in streaming response
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          let text = decoder.decode(value, { stream: true });
          text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
          controller.enqueue(encoder.encode(text));
        },
      });
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return response;
  };
}

// ── Plugin ───────────────────────────────────────────────────────────────────

const plugin: Plugin = async ({ client }) => {
  // Background init — does NOT block OpenCode startup.
  // Uses safe defaults until introspection completes.
  startIntro();

  // Discover CCS instances (fast readdir + access, won't block startup)
  const ccsInstances = await discoverCCSInstances();

  return {
    auth: {
      provider: "anthropic",
      async loader(getAuth: () => Promise<any>, provider: any) {
        const auth = await getAuth();
        if (auth.type === "oauth") {
          // Zero out cost display for Pro/Max subscription
          for (const model of Object.values(provider.models) as any[]) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
          }
          return {
            apiKey: "",
            fetch: createCustomFetch(getAuth, client),
          };
        }
        return {};
      },
      methods: [
        {
          type: "oauth" as const,
          label: "Claude Code (auto)",
          async authorize() {
            const cli = await hasClaude();
            if (!cli) {
              return {
                url: "https://docs.anthropic.com/en/docs/build-with-claude/claude-code",
                instructions:
                  "Claude CLI not found. Install it first:\n\n" +
                  "  npm install -g @anthropic-ai/claude-code\n\n" +
                  "Then run `claude` to log in.\n" +
                  'Or use the "Claude Pro/Max (browser)" method below.',
                method: "auto" as const,
                async callback() {
                  return { type: "failed" as const };
                },
              };
            }

            return {
              url: "https://claude.ai",
              instructions: "Detecting Claude Code credentials...",
              method: "auto" as const,
              async callback() {
                let tokens = await readClaudeCodeCredentials();
                if (!tokens) return { type: "failed" as const };

                if (!isExpiringSoon(tokens.expires)) {
                  return { type: "success" as const, ...tokens };
                }

                // Try direct token refresh first
                try {
                  const refreshed = await refreshTokensSafe(tokens.refresh);
                  return { type: "success" as const, ...refreshed };
                } catch {}

                // Fallback: trigger CLI refresh
                const fresh = await refreshViaClaudeCli();
                if (fresh && !isExpiringSoon(fresh.expires)) {
                  return { type: "success" as const, ...fresh };
                }

                return { type: "failed" as const };
              },
            };
          },
        },
        ...ccsInstances.map((instance) => ({
          type: "oauth" as const,
          label: `CCS (${instance.name})`,
          async authorize() {
            return {
              url: "https://claude.ai",
              instructions: `Detecting credentials for CCS instance "${instance.name}"...`,
              method: "auto" as const,
              async callback() {
                const tokens = await readCCSCredentials(
                  instance.credentialsPath,
                );
                if (!tokens) return { type: "failed" as const };

                if (!isExpiringSoon(tokens.expires)) {
                  return { type: "success" as const, ...tokens };
                }

                try {
                  const refreshed = await refreshTokensSafe(tokens.refresh);
                  return { type: "success" as const, ...refreshed };
                } catch {}

                return { type: "failed" as const };
              },
            };
          },
        })),
        {
          type: "oauth" as const,
          label: "Claude Pro/Max (browser)",
          async authorize() {
            // Await introspection for accurate scopes in the OAuth URL
            const { scopes } = await awaitIntro();
            const { url, verifier } = createAuthorizationRequest(scopes);
            let exchangePromise: Promise<any> | null = null;
            return {
              url,
              instructions:
                "Open the link above to authenticate with your Claude account. " +
                "After authorizing, you'll receive a code — paste it below.",
              method: "code" as const,
              async callback(code: string) {
                if (exchangePromise) return exchangePromise;
                exchangePromise = (async () => {
                  try {
                    const tokens = await exchangeCodeForTokens(
                      code,
                      verifier,
                      getIntro().userAgent,
                    );
                    return { type: "success" as const, ...tokens };
                  } catch {
                    return { type: "failed" as const };
                  }
                })();
                return exchangePromise;
              },
            };
          },
        },
        {
          type: "api" as const,
          label: "API Key (manual)",
          provider: "anthropic",
        },
      ],
    },
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model: any },
      output: { system: string[] },
    ) => {
      if (input.model?.providerID !== "anthropic") return;
      const prefix =
        "You are Claude Code, Anthropic's official CLI for Claude.";
      if (output.system.length > 0) {
        output.system.unshift(prefix);
        output.system[1] = prefix + "\n\n" + output.system[1];
      }
    },
  };
};

export default plugin;
