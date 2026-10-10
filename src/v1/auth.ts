import type { AuthHook } from "@opencode-ai/plugin";
import {
  apiKeyMethodLabel,
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
  resolveCcsTokens,
  resolveCliTokens,
  type CCSInstance,
} from "../shared/credentials.ts";
import { createAuthorizationRequest, createCodeExchange } from "../shared/oauthClient.ts";
import { createCustomFetch, type AuthStore } from "./fetch.ts";

type AuthMethod = AuthHook["methods"][number];
type Provider = Parameters<NonNullable<AuthHook["loader"]>>[1];
type PricedModel = { cost: Provider["models"][string]["cost"] };
type AuthResult = { type: "failed" } | ({ type: "success" } & OAuthTokens);

function toAuthResult(tokens: OAuthTokens | null): AuthResult {
  return tokens ? { type: "success", ...tokens } : { type: "failed" };
}

async function toAuthResultOrFailed(tokens: Promise<OAuthTokens>): Promise<AuthResult> {
  try {
    return toAuthResult(await tokens);
  } catch {
    return { type: "failed" };
  }
}

function cliMethod(): AuthMethod {
  return {
    type: "oauth",
    label: cliMethodLabel,
    async authorize() {
      if (!(await hasClaude())) {
        return {
          url: claudeCodeDocsUrl,
          instructions: cliMissingInstructions,
          method: "auto",
          callback: async () => ({ type: "failed" }),
        };
      }
      return {
        url: claudeSiteUrl,
        instructions: cliDetectionInstructions(),
        method: "auto",
        callback: async () => toAuthResult(await resolveCliTokens()),
      };
    },
  };
}

function ccsMethod(instance: CCSInstance): AuthMethod {
  return {
    type: "oauth",
    label: ccsMethodLabel(instance.name),
    async authorize() {
      return {
        url: claudeSiteUrl,
        instructions: ccsInstructions(instance.name),
        method: "auto",
        callback: async () => toAuthResult(await resolveCcsTokens(instance)),
      };
    },
  };
}

function browserMethod(): AuthMethod {
  return {
    type: "oauth",
    label: browserMethodLabel,
    async authorize() {
      const authorization = createAuthorizationRequest();
      const exchange = createCodeExchange(authorization);
      return {
        url: authorization.url,
        instructions: browserInstructions,
        method: "code",
        callback: (code: string) => toAuthResultOrFailed(exchange(code)),
      };
    },
  };
}

const apiKeyMethod: AuthMethod = { type: "api", label: apiKeyMethodLabel };

export function zeroModelCosts(models: PricedModel[]): void {
  for (const model of models) {
    model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
  }
}

export function createV1Auth(store: AuthStore, ccsInstances: CCSInstance[]): AuthHook {
  return {
    provider: "anthropic",
    async loader(getAuth, provider) {
      const auth = await getAuth();
      if (auth.type !== "oauth") return {};

      zeroModelCosts(Object.values(provider.models));
      return { apiKey: "", fetch: createCustomFetch(getAuth, store) };
    },
    methods: [cliMethod(), ...ccsInstances.map(ccsMethod), browserMethod(), apiKeyMethod],
  };
}
