import type { Credential } from "@opencode/plugin";

type Hook = (event: never) => Promise<void>;

export type FakeModel = {
  id: string;
  providerID: string;
  cost: Array<{ input: number; output: number; cache: { read: number; write: number } }>;
};

type FakeModelEditor = {
  list(): FakeModel[];
  update(providerID: string, modelID: string, update: (draft: FakeModel) => void): void;
};

type FakeRegistration = { method: { id?: string; type: string } };

type FakeIntegrationEditor = {
  method: { update(registration: FakeRegistration): void };
};

type FakeConnection = { type: "credential"; id: string; label: string; method: "oauth" | "key" };

export function oauthCredential(
  methodID = "claude-cli",
  access = "fixture-access",
): Credential.OAuth {
  return {
    type: "oauth",
    methodID: methodID as Credential.OAuth["methodID"],
    access,
    refresh: `${access}-refresh`,
    expires: Date.now() + 60 * 60 * 1000,
  };
}

function toConnection(id: string, credential: Credential.Value): FakeConnection {
  return {
    type: "credential",
    id,
    label: id,
    method: credential.type === "oauth" ? "oauth" : "key",
  };
}

export function createV2Context(initial: Credential.Value | undefined) {
  const accounts = new Map<string, Credential.Value>();
  let activeId: string | undefined;
  if (initial) {
    accounts.set("active", initial);
    activeId = "active";
  }

  const hooks = new Map<string, Hook>();
  const methods = new Map<string, FakeRegistration>([["key", { method: { type: "key" } }]]);
  const model: FakeModel = {
    id: "claude-sonnet",
    providerID: "anthropic",
    cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
  };
  const pristineCost = structuredClone(model.cost);
  let transform: ((editor: FakeModelEditor) => void) | undefined;
  let reloads = 0;

  const context = {
    session: {
      hook: async (name: string, callback: Hook) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
    model: {
      transform: async (callback: (editor: FakeModelEditor) => void) => {
        transform = callback;
      },
      reload: async () => {
        reloads++;
        model.cost = structuredClone(pristineCost);
        transform?.({
          list: () => [model],
          update: (_providerID: string, _modelID: string, update: (draft: FakeModel) => void) =>
            update(model),
        });
      },
    },
    integration: {
      transform: async (callback: (editor: FakeIntegrationEditor) => void) =>
        callback({
          method: {
            update: (registration) =>
              methods.set(registration.method.id ?? registration.method.type, registration),
          },
        }),
      reload: async () => {},
      get: async () => ({
        data: {
          connections: [...accounts].map(([id, credential]) => toConnection(id, credential)),
        },
      }),
      connection: {
        active: async () => {
          const credential = activeId ? accounts.get(activeId) : undefined;
          return activeId && credential ? toConnection(activeId, credential) : undefined;
        },
        resolve: async (connection: FakeConnection) => accounts.get(connection.id),
        status: async () => {},
      },
    },
  };

  return {
    context: context as never,
    hooks,
    methods,
    model,
    reloadCount: () => reloads,
    connect(next: Credential.Value | undefined) {
      if (next) {
        accounts.set("active", next);
        activeId = "active";
      } else {
        accounts.delete("active");
        activeId = undefined;
      }
    },
    addAccount(id: string, credential: Credential.Value) {
      accounts.set(id, credential);
    },
    async fire<T extends object>(name: string, event: T): Promise<T> {
      const hook = hooks.get(name);
      if (!hook) throw new Error(`hook ${name} is not registered`);
      await hook(event as never);
      return event;
    },
  };
}
