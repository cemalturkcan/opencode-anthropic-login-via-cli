import { createHash } from "node:crypto";
import { claudeCodeEntrypoint } from "./constants.ts";
import { getIntro } from "./introspection.ts";

const cchSalt = "59cf53e54c78";
const cchSamplePositions = [4, 7, 20];

export type Message = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

export function extractFirstUserMessageText(messages: Message[]): string {
  const content = messages.find((message) => message.role === "user")?.content;
  if (!Array.isArray(content)) return content ?? "";
  return content.find((block) => block.type === "text")?.text ?? "";
}

export function computeCCH(messageText: string): string {
  return createHash("sha256").update(messageText).digest("hex").slice(0, 5);
}

export function computeVersionSuffix(messageText: string, version: string): string {
  const sampled = cchSamplePositions.map((index) => messageText[index] || "0").join("");
  return createHash("sha256").update(`${cchSalt}${sampled}${version}`).digest("hex").slice(0, 3);
}

export function buildBillingHeaderValue(messages: Message[]): string {
  const { version } = getIntro();
  const text = extractFirstUserMessageText(messages);
  return (
    "x-anthropic-billing-header: " +
    `cc_version=${version}.${computeVersionSuffix(text, version)}; ` +
    `cc_entrypoint=${claudeCodeEntrypoint}; ` +
    `cch=${computeCCH(text)};`
  );
}
