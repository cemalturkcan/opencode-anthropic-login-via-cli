import type { Credential, Plugin as V2Plugin } from "@opencode/plugin";
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration";
import {
  browserInstructions,
  browserMethodLabel,
  ccsInstructions,
  ccsMethodLabel,
  claudeCodeDocsUrl,
  claudeSiteUrl,
  cliDetectionInstructions,
  cliMethodLabel,
  cliMissingInstructions,
} from "../shared/authCopy.ts";
import type { OAuthTokens } from "../shared/constants.ts";
import {
  hasClaude,
  readFreshCliCredentials,
  resolveCcsTokens,
  resolveCliTokens,
  type CCSInstance,
} from "../shared/credentials.ts";
import { awaitIntro } from "../shared/introspection.ts";
import { log } from "../shared/logger.ts";
import {
  createAuthorizationRequest,
  createCodeExchange,
  refreshTokensOnce,
} from "../shared/oauthClient.ts";
import { resolveOAuthCredential } from "./connection.ts";
import { setupV2Http } from "./http.ts";
import { setupSubscriptionPricing, type SubscriptionPricing } from "./pricing.ts";

type OAuthCredential = Credential.OAuth;
type MethodRegistration = IntegrationOAuthMethodRegistration;

export const cliMethodId = "claude-cli";
export const browserMethodId = "claude-browser";
export const migratedV1MethodId = "oauth";
const migratedV1MethodLabel = "Claude Pro/Max (migrated from OpenCode V1)";
const cliRecoverableMethodIds = new Set([cliMethodId, browserMethodId, migratedV1MethodId]);

function ccsMethodId(instance: CCSInstance): string {
  return `ccs-${instance.name}`;
}

function toCredential(methodID: string, tokens: OAuthTokens): OAuthCredential {
  const brandedMethodID = methodID as OAuthCredential["methodID"];
  return { type: "oauth", methodID: brandedMethodID, ...tokens };
}

function withTokens(credential: OAuthCredential, tokens: OAuthTokens): OAuthCredential {
  return { ...credential, ...tokens };
}

async function refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
  try {
    return withTokens(credential, await refreshTokensOnce(credential.refresh));
  } catch (failure) {
    if (!cliRecoverableMethodIds.has(credential.methodID)) throw failure;

    const recovered = await readFreshCliCredentials();
    if (!recovered) throw failure;
    log.info("recovered oauth refresh from claude cli credentials", {
      methodID: credential.methodID,
    });
    return withTokens(credential, recovered);
  }
}

function observed(credential: Promise<OAuthCredential>): Promise<OAuthCredential> {
  credential.catch((failure) => log.warn("authorization failed", { error: String(failure) }));
  return credential;
}

async function requireTokens(
  tokens: Promise<OAuthTokens | null>,
  unavailable: string,
): Promise<OAuthTokens> {
  const resolved = await tokens;
  if (!resolved) throw new Error(unavailable);
  return resolved;
}

function cliMethod(onConnected: () => Promise<void>): MethodRegistration {
  const connect = async () => {
    const tokens = await requireTokens(resolveCliTokens(), "Claude Code credentials unavailable");
    await onConnected();
    return toCredential(cliMethodId, tokens);
  };

  return {
    integrationID: "anthropic",
    method: { id: cliMethodId, type: "oauth", label: cliMethodLabel },
    async authorize() {
      if (!(await hasClaude())) {
        return {
          url: claudeCodeDocsUrl,
          instructions: cliMissingInstructions,
          mode: "auto",
          callback: observed(Promise.reject(new Error("Claude CLI not found"))),
        };
      }

      return {
        url: claudeSiteUrl,
        instructions: cliDetectionInstructions(),
        mode: "auto",
        callback: observed(connect()),
      };
    },
    refresh: refreshCredential,
  };
}

function ccsMethod(instance: CCSInstance, onConnected: () => Promise<void>): MethodRegistration {
  const methodId = ccsMethodId(instance);
  const connect = async () => {
    const tokens = await requireTokens(
      resolveCcsTokens(instance),
      `CCS credentials unavailable for ${instance.name}`,
    );
    await onConnected();
    return toCredential(methodId, tokens);
  };

  return {
    integrationID: "anthropic",
    method: { id: methodId, type: "oauth", label: ccsMethodLabel(instance.name) },
    async authorize() {
      return {
        url: claudeSiteUrl,
        instructions: ccsInstructions(instance.name),
        mode: "auto",
        callback: observed(connect()),
      };
    },
    refresh: refreshCredential,
  };
}

function browserMethod(
  methodId: string,
  label: string,
  onConnected: () => Promise<void>,
): MethodRegistration {
  return {
    integrationID: "anthropic",
    method: { id: methodId, type: "oauth", label },
    async authorize() {
      const { url, verifier } = createAuthorizationRequest((await awaitIntro()).scopes);
      const exchange = createCodeExchange(verifier);
      return {
        url,
        instructions: browserInstructions,
        mode: "code",
        async callback(code: string) {
          const tokens = await exchange(code);
          await onConnected();
          return toCredential(methodId, tokens);
        },
      };
    },
    refresh: refreshCredential,
  };
}

export function oauthMethods(
  instances: CCSInstance[],
  pricing: SubscriptionPricing,
): MethodRegistration[] {
  const onConnected = () => pricing.sync(true);
  return [
    cliMethod(onConnected),
    ...instances.map((instance) => ccsMethod(instance, onConnected)),
    browserMethod(browserMethodId, browserMethodLabel, onConnected),
    browserMethod(migratedV1MethodId, migratedV1MethodLabel, onConnected),
  ];
}

export async function setupV2Auth(
  ctx: Pick<V2Plugin.Context, "integration" | "model" | "session">,
  instances: CCSInstance[],
): Promise<void> {
  const pricing = await setupSubscriptionPricing(ctx.model);
  await setupV2Http(ctx.integration, ctx.session, pricing);

  await ctx.integration.transform((editor) => {
    for (const method of oauthMethods(instances, pricing)) editor.method.update(method);
  });
  await ctx.integration.reload();

  await pricing.sync((await resolveOAuthCredential(ctx.integration)) !== undefined);
}
