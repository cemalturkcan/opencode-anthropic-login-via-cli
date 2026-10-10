import type { Credential, Plugin as V2Plugin } from "@opencode/plugin";
import { log } from "../shared/logger.ts";

export type AccountIntegration = Pick<V2Plugin.Context["integration"], "connection" | "get">;
type Connection = NonNullable<Awaited<ReturnType<AccountIntegration["connection"]["active"]>>>;
type IntegrationLookup = Parameters<AccountIntegration["get"]>[0];

const anthropicLookup = { integrationID: "anthropic" } as IntegrationLookup;

export type SelectedAccount = { connection: Connection; credential: Credential.OAuth };

export type AccountRouter = {
  select(sessionID: string): Promise<SelectedAccount | undefined>;
  failover(
    sessionID: string,
    failed: SelectedAccount,
    coolUntil: number,
  ): Promise<SelectedAccount | undefined>;
};

function connectionKey(connection: Connection): string {
  return connection.type === "credential" ? connection.id : `env:${connection.name}`;
}

export function createAccountRouter(
  integration: AccountIntegration,
  now: () => number = Date.now,
): AccountRouter {
  const cooldowns = new Map<string, number>();
  const pins = new Map<string, string>();

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

  async function firstHealthy(excluded: string): Promise<SelectedAccount | undefined> {
    const candidates = (await oauthConnections()).filter(
      (connection) => connectionKey(connection) !== excluded && !isCooling(connection),
    );
    const resolved = await Promise.all(candidates.map(resolveOAuth));
    return resolved.find((account) => account !== undefined);
  }

  async function pinnedAccount(sessionID: string): Promise<SelectedAccount | undefined> {
    const pinned = pins.get(sessionID);
    if (!pinned) return undefined;
    const connection = (await oauthConnections()).find((entry) => connectionKey(entry) === pinned);
    const account =
      connection && !isCooling(connection) ? await resolveOAuth(connection) : undefined;
    if (!account) pins.delete(sessionID);
    return account;
  }

  return {
    async select(sessionID) {
      const pinned = await pinnedAccount(sessionID);
      if (pinned) return pinned;

      const active = await activeConnection();
      if (!active) return undefined;
      if (isCooling(active))
        return (await firstHealthy(connectionKey(active))) ?? resolveOAuth(active);
      return resolveOAuth(active);
    },

    async failover(sessionID, failed, coolUntil) {
      const failedKey = connectionKey(failed.connection);
      cooldowns.set(failedKey, coolUntil);
      const alternative = await firstHealthy(failedKey);
      if (!alternative) return undefined;

      pins.set(sessionID, connectionKey(alternative.connection));
      log.info("switched anthropic account after a rate limit", {
        from: failed.connection.type === "credential" ? failed.connection.label : failedKey,
        to: alternative.connection.type === "credential" ? alternative.connection.label : "env",
      });
      return alternative;
    },
  };
}
