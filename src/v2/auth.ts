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
import { accountProfile } from "../shared/identity.ts";
import { isJsonObject, isJsonString, parseJson } from "../shared/json.ts";
import { log } from "../shared/logger.ts";
import {
  createAuthorizationRequest,
  createCodeExchange,
  refreshTokensOnce,
} from "../shared/oauthClient.ts";
import { createAccountRouter } from "./accounts.ts";
import { setupV2Http } from "./http.ts";
import { setupSubscriptionPricing, type SubscriptionPricing } from "./pricing.ts";

type OAuthCredential = Credential.OAuth;
type MethodRegistration = IntegrationOAuthMethodRegistration;

export const cliMethodId = "claude-cli";
export const browserMethodId = "claude-browser";
export const migratedV1MethodId = "oauth";
const migratedV1MethodLabel = "Claude Pro/Max (migrated from OpenCode V1)";

function ccsMethodId(instance: CCSInstance): string {
  return `ccs-${instance.name}`;
}

function toCredential(methodID: string, tokens: OAuthTokens): OAuthCredential {
  const brandedMethodID = methodID as OAuthCredential["methodID"];
  return { type: "oauth", methodID: brandedMethodID, ...tokens };
}

async function connectedCredential(
  methodID: string,
  tokens: OAuthTokens,
): Promise<OAuthCredential> {
  const credential = toCredential(methodID, tokens);
  const profile = await accountProfile(tokens.access);
  if (!profile) return credential;
  return { ...credential, metadata: { email: profile.email, accountUuid: profile.uuid } };
}

function metadataField(credential: OAuthCredential, field: string): string | undefined {
  const metadata = parseJson(JSON.stringify(credential.metadata ?? {}));
  if (!isJsonObject(metadata)) return undefined;
  const value = metadata[field];
  return isJsonString(value) ? value : undefined;
}

export function credentialLabel(credential: OAuthCredential): string | undefined {
  return metadataField(credential, "email");
}

async function isSameAccount(
  credential: OAuthCredential,
  recovered: OAuthTokens,
): Promise<boolean> {
  if (credential.methodID === cliMethodId) return true;
  const expected = metadataField(credential, "accountUuid");
  if (!expected) return credential.methodID === migratedV1MethodId;
  return (await accountProfile(recovered.access))?.uuid === expected;
}

function withTokens(credential: OAuthCredential, tokens: OAuthTokens): OAuthCredential {
  return { ...credential, ...tokens };
}

async function refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
  try {
    return withTokens(credential, await refreshTokensOnce(credential.refresh));
  } catch (failure) {
    if (credential.methodID.startsWith("ccs-")) throw failure;

    const recovered = await readFreshCliCredentials();
    if (!recovered || !(await isSameAccount(credential, recovered))) throw failure;
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
    return connectedCredential(cliMethodId, tokens);
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
    label: credentialLabel,
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
    return connectedCredential(methodId, tokens);
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
    label: credentialLabel,
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
      const authorization = createAuthorizationRequest();
      const exchange = createCodeExchange(authorization);
      return {
        url: authorization.url,
        instructions: browserInstructions,
        mode: "code",
        async callback(code: string) {
          const tokens = await exchange(code);
          await onConnected();
          return connectedCredential(methodId, tokens);
        },
      };
    },
    refresh: refreshCredential,
    label: credentialLabel,
  };
}

export function oauthMethods(
  instances: CCSInstance[],
  pricing: SubscriptionPricing,
  hasMigratedV1Credential: boolean,
): MethodRegistration[] {
  const onConnected = () => pricing.sync(true);
  const methods = [
    cliMethod(onConnected),
    ...instances.map((instance) => ccsMethod(instance, onConnected)),
    browserMethod(browserMethodId, browserMethodLabel, onConnected),
  ];
  if (!hasMigratedV1Credential) return methods;
  return [...methods, browserMethod(migratedV1MethodId, migratedV1MethodLabel, onConnected)];
}

export async function setupV2Auth(
  ctx: Pick<V2Plugin.Context, "integration" | "model" | "session">,
  instances: CCSInstance[],
): Promise<void> {
  const pricing = await setupSubscriptionPricing(ctx.model);
  const router = createAccountRouter(ctx.integration);
  await setupV2Http(router, ctx.session, pricing);

  const hasMigratedV1Credential = await router.hasCredentialFrom(migratedV1MethodId);
  await ctx.integration.transform((editor) => {
    for (const method of oauthMethods(instances, pricing, hasMigratedV1Credential)) {
      editor.method.update(method);
    }
  });
  await ctx.integration.reload();

  await pricing.sync((await router.select()) !== undefined);
}
