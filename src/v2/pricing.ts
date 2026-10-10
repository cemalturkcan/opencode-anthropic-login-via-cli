import type { Plugin as V2Plugin } from "@opencode/plugin";
import type { USDPerMillionTokens } from "@opencode/schema/money";
import { log } from "../shared/logger.ts";

type ModelAccess = Pick<V2Plugin.Context["model"], "transform" | "reload">;

export type SubscriptionPricing = {
  sync(subscription: boolean): Promise<void>;
};

const free = 0 as USDPerMillionTokens;

export async function setupSubscriptionPricing(model: ModelAccess): Promise<SubscriptionPricing> {
  let subscription = false;

  await model.transform((editor) => {
    if (!subscription) return;
    for (const entry of editor.list()) {
      if (String(entry.providerID) !== "anthropic") continue;
      editor.update("anthropic", String(entry.id), (draft) => {
        draft.cost = draft.cost.map((tier) => ({
          ...tier,
          input: free,
          output: free,
          cache: { read: free, write: free },
        }));
      });
    }
  });

  return {
    async sync(next) {
      if (next === subscription) return;
      subscription = next;
      try {
        await model.reload();
      } catch (failure) {
        log.warn("failed to reload model pricing", { error: String(failure) });
      }
    },
  };
}
