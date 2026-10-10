import { describe, expect, it } from "bun:test";
import {
  buildBillingHeaderValue,
  computeCCH,
  computeVersionSuffix,
  extractFirstUserMessageText,
} from "./cch.ts";
import { getIntro } from "./introspection.ts";

describe("extractFirstUserMessageText", () => {
  it("reads string content of the first user message", () => {
    expect(
      extractFirstUserMessageText([
        { role: "assistant", content: "ignored" },
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ]),
    ).toBe("first");
  });

  it("reads the first text block of block content", () => {
    expect(
      extractFirstUserMessageText([
        { role: "user", content: [{ type: "image" }, { type: "text", text: "described" }] },
      ]),
    ).toBe("described");
  });

  it("returns an empty string without user text", () => {
    expect(extractFirstUserMessageText([{ role: "user", content: [{ type: "image" }] }])).toBe("");
    expect(extractFirstUserMessageText([])).toBe("");
  });
});

describe("billing header", () => {
  it("hashes the message into a five character cch", () => {
    expect(computeCCH("Hello")).toBe("185f8");
  });

  it("samples fixed positions and pads short messages", () => {
    expect(computeVersionSuffix("Hi", "2.1.84")).toHaveLength(3);
    expect(computeVersionSuffix("Hi", "2.1.84")).toBe(computeVersionSuffix("Hi!", "2.1.84"));
  });

  it("builds the header from the current cli version", () => {
    const { version } = getIntro();

    expect(buildBillingHeaderValue([{ role: "user", content: "Hello" }])).toBe(
      `x-anthropic-billing-header: cc_version=${version}.${computeVersionSuffix("Hello", version)}; cc_entrypoint=sdk-cli; cch=185f8;`,
    );
  });
});
