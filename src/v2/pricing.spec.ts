import { describe, expect, it } from "bun:test";
import { setupSubscriptionPricing } from "./pricing.ts";

type Tier = { input: number; output: number; cache: { read: number; write: number } };
type Model = { id: string; providerID: string; cost: Tier[] };
type Editor = {
  list(): Model[];
  update(provider: string, id: string, update: (draft: Model) => void): void;
};

const paid = (): Tier[] => [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }];
const free: Tier[] = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }];

function fakeModels(reloadFails = false) {
  const models: Model[] = [
    { id: "sonnet", providerID: "anthropic", cost: paid() },
    { id: "gpt", providerID: "openai", cost: paid() },
  ];
  let transform: ((editor: Editor) => void) | undefined;
  const domain = {
    transform: async (callback: (editor: Editor) => void) => {
      transform = callback;
    },
    reload: async () => {
      if (reloadFails) throw new Error("reload failed");
      for (const model of models) model.cost = paid();
      transform?.({
        list: () => models,
        update: (_provider: string, id: string, update: (draft: Model) => void) =>
          update(models.find((model) => model.id === id)!),
      });
    },
  };
  return { models, domain: domain as never };
}

describe("subscription pricing", () => {
  it("makes only anthropic models free while a subscription is active", async () => {
    const { models, domain } = fakeModels();
    const pricing = await setupSubscriptionPricing(domain);

    await pricing.sync(true);

    expect(models[0].cost).toEqual(free);
    expect(models[1].cost).toEqual(paid());
  });

  it("restores prices after switching back to an api key", async () => {
    const { models, domain } = fakeModels();
    const pricing = await setupSubscriptionPricing(domain);

    await pricing.sync(true);
    await pricing.sync(false);

    expect(models[0].cost).toEqual(paid());
  });

  it("does not reload when nothing changed", async () => {
    const { models, domain } = fakeModels();
    const pricing = await setupSubscriptionPricing(domain);
    models[0].cost = [];

    await pricing.sync(false);

    expect(models[0].cost).toEqual([]);
  });

  it("survives a failing reload", async () => {
    const { domain } = fakeModels(true);
    const pricing = await setupSubscriptionPricing(domain);

    await expect(pricing.sync(true)).resolves.toBeUndefined();
  });
});
