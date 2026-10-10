import { createHash } from "node:crypto";
import { claudeCodeEntrypoint } from "./constants.ts";
import { getIntro } from "./introspection.ts";

const fingerprintSalt = "59cf53e54c78";
const fingerprintPositions = [4, 7, 20];
const systemReminderPrefix = "<system-reminder>";

type TextBlock = { type?: string; text?: string };

export type Message = {
  role?: string;
  content?: string | TextBlock[];
};

function userTexts(message: Message): string[] {
  if (message.role !== "user") return [];
  if (!Array.isArray(message.content)) return message.content ? [message.content] : [];
  return message.content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text ?? "");
}

export function fingerprintText(messages: Message[]): string {
  const texts = messages.flatMap(userTexts);
  return texts.find((text) => !text.startsWith(systemReminderPrefix)) ?? "";
}

export function computeVersionSuffix(messageText: string, version: string): string {
  const sampled = fingerprintPositions.map((index) => messageText[index] || "0").join("");
  return createHash("sha256")
    .update(`${fingerprintSalt}${sampled}${version}`)
    .digest("hex")
    .slice(0, 3);
}

export function buildBillingHeaderValue(messages: Message[]): string {
  const { version } = getIntro();
  const suffix = computeVersionSuffix(fingerprintText(messages), version);
  return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=${claudeCodeEntrypoint};`;
}
