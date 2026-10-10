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

type Pin = { key: string; from: string; until: number };

export function createAccountRouter(
  integration: AccountIntegration,
  now: () => number = Date.now,
): AccountRouter {
  const cooldowns = new Map<string, number>();
  const pins = new Map<string, Pin>();

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

  async function pinnedAccount(
    sessionID: string,
    activeKey: string,
  ): Promise<SelectedAccount | undefined> {
    const pin = pins.get(sessionID);
    if (!pin) return undefined;
    if (pin.from !== activeKey || pin.until <= now()) {
      pins.delete(sessionID);
      return undefined;
    }

    const connection = (await oauthConnections()).find((entry) => connectionKey(entry) === pin.key);
    const account =
      connection && !isCooling(connection) ? await resolveOAuth(connection) : undefined;
    if (!account) pins.delete(sessionID);
    return account;
  }

  return {
    async select(sessionID) {
      const active = await activeConnection();
      if (!active) return undefined;
      const activeKey = connectionKey(active);

      const pinned = await pinnedAccount(sessionID, activeKey);
      if (pinned) return pinned;
      if (isCooling(active)) return (await firstHealthy(activeKey)) ?? resolveOAuth(active);
      return resolveOAuth(active);
    },

    async failover(sessionID, failed, coolUntil) {
      const failedKey = connectionKey(failed.connection);
      cooldowns.set(failedKey, coolUntil);
      const alternative = await firstHealthy(failedKey);
      if (!alternative) return undefined;

      const active = await activeConnection();
      pins.set(sessionID, {
        key: connectionKey(alternative.connection),
        from: active ? connectionKey(active) : failedKey,
        until: coolUntil,
      });
      log.info("switched anthropic account after a rate limit", {
        from: failedKey,
        to: connectionKey(alternative.connection),
        until: new Date(coolUntil).toISOString(),
      });
      return alternative;
    },
  };
}
