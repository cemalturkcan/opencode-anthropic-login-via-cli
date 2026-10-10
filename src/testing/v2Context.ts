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

export function oauthCredential(
  methodID = "claude-cli",
  access = "fixture-access",
): Credential.OAuth {
  return {
    type: "oauth",
    methodID: methodID as Credential.OAuth["methodID"],
    access,
    refresh: "fixture-refresh",
    expires: Date.now() + 60 * 60 * 1000,
  };
}

export function createV2Context(initial: Credential.Value | undefined) {
  let credential = initial;
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
      connection: {
        active: async () =>
          credential
            ? { type: "credential", id: "active", label: "Anthropic", method: "m" }
            : undefined,
        resolve: async () => credential,
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
      credential = next;
    },
    async fire<T extends object>(name: string, event: T): Promise<T> {
      const hook = hooks.get(name);
      if (!hook) throw new Error(`hook ${name} is not registered`);
      await hook(event as never);
      return event;
    },
  };
}
