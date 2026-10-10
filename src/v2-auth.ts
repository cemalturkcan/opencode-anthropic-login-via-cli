import type { Credential, Plugin as V2Plugin } from "@opencode/plugin";
import {
  discoverCCSInstances,
  hasClaude,
  isExpiringSoon,
  readCCSCredentials,
  readClaudeCodeCredentials,
  refreshTokensSafe,
  refreshViaClaudeCli,
  setCurrentRefreshToken,
  type CCSInstance,
} from "./credentials.ts";
import { log } from "./logger.ts";
import { createAuthorizationRequest, exchangeCodeForTokens } from "./pkce.ts";
import { awaitIntro, getIntro, getLatestCliVersion, startIntro } from "./introspection.ts";
import { setupV2Http } from "./v2-http.ts";

type Context = V2Plugin.Context;
type OAuthCredential = Credential.OAuth;

function oauthCredential(
  methodID: string,
  tokens: { access: string; refresh: string; expires: number },
): OAuthCredential {
  return { type: "oauth", methodID: methodID as OAuthCredential["methodID"], ...tokens };
}

async function refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
  const tokens = await refreshTokensSafe(credential.refresh);
  setCurrentRefreshToken(tokens.refresh);
  return oauthCredential(credential.methodID, tokens);
}

async function cliTokens() {
  let tokens = await readClaudeCodeCredentials();
  if (!tokens) return null;
  if (!isExpiringSoon(tokens.expires)) return tokens;

  try {
    tokens = await refreshTokensSafe(tokens.refresh);
    return tokens;
  } catch (error) {
    log.warn("Token refresh failed in V2 auth callback", { error: String(error) });
  }

  const fresh = await refreshViaClaudeCli();
  return fresh && !isExpiringSoon(fresh.expires) ? fresh : null;
}

async function ccsTokens(instance: CCSInstance) {
  let tokens = await readCCSCredentials(instance.credentialsPath);
  if (!tokens) return null;
  if (!isExpiringSoon(tokens.expires)) return tokens;

  try {
    tokens = await refreshTokensSafe(tokens.refresh);
    return tokens;
  } catch (error) {
    log.warn("CCS token refresh failed in V2 auth callback", {
      instance: instance.name,
      error: String(error),
    });
    return null;
  }
}

function oauthMethods(instances: CCSInstance[], markOAuthConnected: () => Promise<void>) {
  return [
    {
      integrationID: "anthropic",
      method: { id: "claude-cli", type: "oauth" as const, label: "Claude Code (auto)" },
      authorize: async () => {
        const cli = await hasClaude();
        const latestVersion = getLatestCliVersion();
        const versionWarning = latestVersion
          ? `\n\nClaude CLI is outdated (${getIntro().version} → ${latestVersion}). Run:\n  npm install -g @anthropic-ai/claude-code`
          : "";
        return {
          url: cli
            ? "https://claude.ai"
            : "https://docs.anthropic.com/en/docs/build-with-claude/claude-code",
          instructions: cli
            ? `Detecting Claude Code credentials...${versionWarning}`
            : "Claude CLI not found. Install it, run `claude` to log in, or use the browser method.",
          mode: "auto" as const,
          callback: (async () => {
            const tokens = await cliTokens();
            if (!tokens) throw new Error("Claude Code credentials unavailable");
            await markOAuthConnected();
            return oauthCredential("claude-cli", tokens);
          })(),
        };
      },
      refresh: refreshCredential,
    },
    ...instances.map((instance) => ({
      integrationID: "anthropic",
      method: {
        id: `ccs-${instance.name}`,
        type: "oauth" as const,
        label: `CCS (${instance.name})`,
      },
      authorize: async () => ({
        url: "https://claude.ai",
        instructions: `Detecting credentials for CCS instance "${instance.name}"...`,
        mode: "auto" as const,
        callback: (async () => {
          const tokens = await ccsTokens(instance);
          if (!tokens) throw new Error(`CCS credentials unavailable for ${instance.name}`);
          await markOAuthConnected();
          return oauthCredential(`ccs-${instance.name}`, tokens);
        })(),
      }),
      refresh: refreshCredential,
    })),
    {
      integrationID: "anthropic",
      method: { id: "claude-browser", type: "oauth" as const, label: "Claude Pro/Max (browser)" },
      authorize: async () => {
        const { scopes } = await awaitIntro();
        const { url, verifier } = createAuthorizationRequest(scopes);
        return {
          url,
          instructions:
            "Open the link above to authenticate with your Claude account. After authorizing, paste the code below.",
          mode: "code" as const,
          callback: async (code: string) => {
            try {
              const tokens = await exchangeCodeForTokens(code, verifier, getIntro().userAgent);
              await markOAuthConnected();
              return oauthCredential("claude-browser", tokens);
            } catch (error) {
              log.error("V2 token exchange failed", { error: String(error) });
              throw error;
            }
          },
        };
      },
      refresh: refreshCredential,
    },
  ];
}

async function hasOAuthConnection(ctx: Context): Promise<boolean> {
  try {
    const connection = await ctx.integration.connection.active("anthropic");
    if (!connection) return false;
    return (await ctx.integration.connection.resolve(connection))?.type === "oauth";
  } catch (error) {
    log.warn("Failed to inspect Anthropic connection", { error: String(error) });
    return false;
  }
}

export async function setupV2Auth(
  ctx: Context,
  ccsInstances?: CCSInstance[],
  initialize: () => void = startIntro,
): Promise<void> {
  log.info("V2 plugin initializing");
  initialize();
  const instances = ccsInstances ?? (await discoverCCSInstances());
  await setupV2Http(ctx);
  log.info("Discovered CCS instances", { count: instances.length });

  let subscriptionAuth = false;
  await ctx.model.transform((editor) => {
    if (!subscriptionAuth) return;
    for (const model of editor.list().filter((item) => String(item.providerID) === "anthropic")) {
      editor.update("anthropic", String(model.id), (draft) => {
        draft.cost = draft.cost.map((tier) => ({
          ...tier,
          input: 0 as unknown as typeof tier.input,
          output: 0 as unknown as typeof tier.output,
          cache: {
            read: 0 as unknown as typeof tier.cache.read,
            write: 0 as unknown as typeof tier.cache.write,
          },
        }));
      });
    }
  });

  const reloadPricing = async () => {
    try {
      await ctx.model.reload();
    } catch (error) {
      log.warn("Failed to refresh subscription model pricing", { error: String(error) });
    }
  };

  await ctx.integration.transform((editor) => {
    for (const method of oauthMethods(instances, async () => {
      subscriptionAuth = true;
      await reloadPricing();
    }))
      editor.method.update(method);
  });
  await ctx.integration.reload();

  subscriptionAuth = await hasOAuthConnection(ctx);
  if (subscriptionAuth) await reloadPricing();
}
