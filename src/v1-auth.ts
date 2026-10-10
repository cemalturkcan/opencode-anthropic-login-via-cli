import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import {
  clearRefreshInFlight,
  getCurrentRefreshToken,
  hasClaude,
  isExpiringSoon,
  readCCSCredentials,
  readClaudeCodeCredentials,
  refreshTokensSafe,
  refreshViaClaudeCli,
  resetRefreshState,
  setCurrentRefreshToken,
  type CCSInstance,
} from "./credentials.ts";
import { awaitIntro, getIntro, getLatestCliVersion } from "./introspection.ts";
import { log } from "./logger.ts";
import { createCustomFetch } from "./fetch.ts";
import { createAuthorizationRequest, exchangeCodeForTokens } from "./pkce.ts";

type ClientApi = Parameters<V1Plugin>[0]["client"];

export function createV1Auth(client: ClientApi, ccsInstances: CCSInstance[]) {
  return {
    provider: "anthropic",

    async loader(getAuth: () => Promise<any>, provider: any) {
      const auth = await getAuth();

      if (auth.type === "oauth") {
        if (auth.refresh && auth.refresh !== getCurrentRefreshToken()) {
          clearRefreshInFlight();
          setCurrentRefreshToken(auth.refresh);
        }

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

      if (getCurrentRefreshToken()) resetRefreshState();
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

          const latestVersion = getLatestCliVersion();
          const versionWarning = latestVersion
            ? `\n\n⚠️  Claude CLI is outdated (${getIntro().version} → ${latestVersion}). Run:\n  npm install -g @anthropic-ai/claude-code`
            : "";

          return {
            url: "https://claude.ai",
            instructions: `Detecting Claude Code credentials...${versionWarning}`,
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
              } catch (error) {
                log.warn("Token refresh failed in auth callback", { error: String(error) });
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
              } catch (error) {
                log.warn("CCS token refresh failed", {
                  instance: instance.name,
                  error: String(error),
                });
              }

              return { type: "failed" as const };
            },
          };
        },
      })),
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
                  const tokens = await exchangeCodeForTokens(code, verifier, getIntro().userAgent);
                  return { type: "success" as const, ...tokens };
                } catch (error) {
                  log.error("Token exchange failed", { error: String(error) });
                  exchangePromise = null;
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
  };
}
