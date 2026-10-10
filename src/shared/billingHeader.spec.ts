import { describe, expect, it } from "bun:test";
import { buildBillingHeaderValue, computeVersionSuffix, fingerprintText } from "./billingHeader.ts";
import { getIntro } from "./introspection.ts";

const capturedMessages = [
  {
    role: "user",
    content: [
      { type: "text", text: "<system-reminder>\nCodebase and user instructions are shown below." },
      { type: "text", text: "<system-reminder>\nAs you answer the user's questions" },
      { type: "text", text: "Reply with the single word ok." },
    ],
  },
];

describe("fingerprintText", () => {
  it("skips system reminders and uses the first real user text", () => {
    expect(fingerprintText(capturedMessages)).toBe("Reply with the single word ok.");
  });

  it("reads string content", () => {
    expect(
      fingerprintText([
        { role: "assistant", content: "ignored" },
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ]),
    ).toBe("first");
  });

  it("returns an empty string without user text", () => {
    expect(fingerprintText([{ role: "user", content: [{ type: "image" }] }])).toBe("");
    expect(fingerprintText([])).toBe("");
  });
});

describe("computeVersionSuffix", () => {
  it("reproduces the suffix claude code 2.1.296 sent for a captured request", () => {
    expect(computeVersionSuffix("Reply with the single word ok.", "2.1.296")).toBe("2ba");
  });

  it("pads messages shorter than the sampled positions", () => {
    expect(computeVersionSuffix("Hi", "2.1.296")).toBe(computeVersionSuffix("Hi!", "2.1.296"));
  });
});

describe("buildBillingHeaderValue", () => {
  it("matches the captured claude code header shape without a cch field", () => {
    const { version } = getIntro();

    expect(buildBillingHeaderValue(capturedMessages)).toBe(
      `x-anthropic-billing-header: cc_version=${version}.${computeVersionSuffix("Reply with the single word ok.", version)}; cc_entrypoint=sdk-cli;`,
    );
  });
});
