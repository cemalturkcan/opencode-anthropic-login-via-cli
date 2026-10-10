import type { Credential, Plugin as V2Plugin } from "@opencode/plugin";
import { log } from "../shared/logger.ts";

export type AccountIntegration = Pick<V2Plugin.Context["integration"], "connection" | "get">;
type Connection = NonNullable<Awaited<ReturnType<AccountIntegration["connection"]["active"]>>>;
type IntegrationLookup = Parameters<AccountIntegration["get"]>[0];

const anthropicLookup = { integrationID: "anthropic" } as IntegrationLookup;

export type SelectedAccount = { connection: Connection; credential: Credential.OAuth };

export type AccountRouter = {
  hasCredentialFrom(methodID: string): Promise<boolean>;
  select(): Promise<SelectedAccount | undefined>;
  failover(failed: SelectedAccount, coolUntil: number): Promise<SelectedAccount | undefined>;
};

function connectionKey(connection: Connection): string {
  return connection.type === "credential" ? connection.id : `env:${connection.name}`;
}

export function createAccountRouter(
  integration: AccountIntegration,
  now: () => number = Date.now,
): AccountRouter {
  const cooldowns = new Map<string, number>();

  const isCooling = (connection: Connection) =>
    (cooldowns.get(connectionKey(connection)) ?? 0) > now();

  async function resolveOAuth(connection: Connection): Promise<SelectedAccount | undefined> {
    try {
      const credential = await integration.connection.resolve(connection);
      return credential?.type === "oauth" ? { connection, credential } : undefined;
    } catch (failure) {
      log.warn("failed to resolve anthropic connection", { error: String(failure) });
      return undefined;
    }
  }

  async function oauthConnections(): Promise<Connection[]> {
    try {
      const { data } = await integration.get(anthropicLookup);
      return data.connections.filter(
        (connection) => connection.type === "credential" && connection.method === "oauth",
      );
    } catch (failure) {
      log.warn("failed to list anthropic connections", { error: String(failure) });
      return [];
    }
  }

  async function activeConnection(): Promise<Connection | undefined> {
    try {
      return await integration.connection.active("anthropic");
    } catch (failure) {
      log.warn("failed to read the active anthropic connection", { error: String(failure) });
      return undefined;
    }
  }

  async function firstUsable(candidates: Connection[]): Promise<SelectedAccount | undefined> {
    const [next, ...rest] = candidates;
    if (!next) return undefined;
    return (await resolveOAuth(next)) ?? firstUsable(rest);
  }

  async function firstHealthy(excluded: string): Promise<SelectedAccount | undefined> {
    const candidates = (await oauthConnections()).filter(
      (connection) => connectionKey(connection) !== excluded && !isCooling(connection),
    );
    return firstUsable(candidates);
  }

  async function usesMethod(methodID: string, candidates: Connection[]): Promise<boolean> {
    const [next, ...rest] = candidates;
    if (!next) return false;
    if ((await resolveOAuth(next))?.credential.methodID === methodID) return true;
    return usesMethod(methodID, rest);
  }

  return {
    async hasCredentialFrom(methodID) {
      return usesMethod(methodID, await oauthConnections());
    },

    async select() {
      const active = await activeConnection();
      if (!active) return undefined;
      if (!isCooling(active)) return resolveOAuth(active);
      return (await firstHealthy(connectionKey(active))) ?? resolveOAuth(active);
    },

    async failover(failed, coolUntil) {
      const failedKey = connectionKey(failed.connection);
      cooldowns.set(failedKey, coolUntil);
      const alternative = await firstHealthy(failedKey);
      if (!alternative) return undefined;

      log.info("switched anthropic account after a rate limit", {
        from: failedKey,
        to: connectionKey(alternative.connection),
        until: new Date(coolUntil).toISOString(),
      });
      return alternative;
    },
  };
}
