import type { Plugin } from "@opencode-ai/plugin";
import { log } from "./logger.ts";
import { startIntro, getIntro, awaitIntro } from "./introspection.ts";
import { createAuthorizationRequest, exchangeCodeForTokens } from "./pkce.ts";
import {
  getCurrentRefreshToken,
  setCurrentRefreshToken,
  clearRefreshInFlight,
  resetRefreshState,
  readClaudeCodeCredentials,
  readCCSCredentials,
  refreshViaClaudeCli,
  refreshTokensSafe,
  discoverCCSInstances,
  hasClaude,
  isExpiringSoon,
} from "./credentials.ts";
import { createCustomFetch } from "./fetch.ts";

// ── Plugin Definition ────────────────────────────────────────────────────────

const plugin: Plugin = async ({ client }) => {
  log.info("Plugin initializing");
  startIntro();

  const ccsInstances = await discoverCCSInstances();
  log.info("Discovered CCS instances", { count: ccsInstances.length });

  return {
    auth: {
      provider: "anthropic",

      async loader(getAuth: () => Promise<any>, provider: any) {
        const auth = await getAuth();

        if (auth.type === "oauth") {
          // Detect account switch — reset stale state
          if (auth.refresh && auth.refresh !== getCurrentRefreshToken()) {
            clearRefreshInFlight();
            setCurrentRefreshToken(auth.refresh);
          }

          // Zero out cost display for Pro/Max subscription
          for (const model of Object.values(provider.models) as any[]) {
            model.cost = {
              input: 0,
              output: 0,
              cache: { read: 0, write: 0 },
            };
          }

          return {
            apiKey: "",
            fetch: createCustomFetch(getAuth, client),
          };
        }

        // Switching away from OAuth — clear state
        if (getCurrentRefreshToken()) {
          resetRefreshState();
        }
        return {};
      },

      methods: [
        // ── Claude Code (auto) ───────────────────────────────────────────
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

                try {
                  const refreshed = await refreshTokensSafe(tokens.refresh);
                  return { type: "success" as const, ...refreshed };
                } catch (e) {
                  log.warn("Token refresh failed in auth callback", {
                    error: String(e),
                  });
                }

                const fresh = await refreshViaClaudeCli();
                if (fresh && !isExpiringSoon(fresh.expires)) {
                  return { type: "success" as const, ...fresh };
                }

                return { type: "failed" as const };
              },
            };
          },
        },

        // ── CCS Instances ────────────────────────────────────────────────
        ...ccsInstances.map((instance) => ({
          type: "oauth" as const,
          label: `CCS (${instance.name})`,
          async authorize() {
            return {
              url: "https://claude.ai",
              instructions: `Detecting credentials for CCS instance "${instance.name}"...`,
              method: "auto" as const,
              async callback() {
                const tokens = await readCCSCredentials(instance.credentialsPath);
                if (!tokens) return { type: "failed" as const };

                if (!isExpiringSoon(tokens.expires)) {
                  return { type: "success" as const, ...tokens };
                }

                try {
                  const refreshed = await refreshTokensSafe(tokens.refresh);
                  return { type: "success" as const, ...refreshed };
                } catch (e) {
                  log.warn("CCS token refresh failed", {
                    instance: instance.name,
                    error: String(e),
                  });
                }

                return { type: "failed" as const };
              },
            };
          },
        })),

        // ── Browser OAuth (PKCE) ─────────────────────────────────────────
        {
          type: "oauth" as const,
          label: "Claude Pro/Max (browser)",
          async authorize() {
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
                  } catch (e) {
                    log.error("Token exchange failed", {
                      error: String(e),
                    });
                    return { type: "failed" as const };
                  }
                })();
                return exchangePromise;
              },
            };
          },
        },

        // ── API Key (manual) ─────────────────────────────────────────────
        {
          type: "api" as const,
          label: "API Key (manual)",
          provider: "anthropic",
        },
      ],
    },

    // ── System Prompt Transform ──────────────────────────────────────────────
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model: any },
      output: { system: string[] },
    ) => {
      if (input.model?.providerID !== "anthropic") return;
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude.";
      if (output.system.length > 0) {
        output.system.unshift(prefix);
      }
    },
  };
};

export default plugin;
