import { describe, expect, it } from "vitest";

import { redactSensitiveProcessArgs } from "./processArgumentRedaction";

describe("redactSensitiveProcessArgs", () => {
  it("redacts sensitive flag values in both supported forms", () => {
    expect(redactSensitiveProcessArgs("tool --api-key secret --token=other --verbose")).toBe(
      "tool --api-key [redacted] --token=[redacted] --verbose",
    );
  });

  it("redacts bearer and OpenAI-style secret tokens", () => {
    expect(redactSensitiveProcessArgs("Bearer abc.def sk-abcdefgh1234 keep-me")).toBe(
      "Bearer [redacted] [redacted] keep-me",
    );
  });

  it("leaves unrelated process arguments unchanged", () => {
    const args = "bun run dev --port 3000";
    expect(redactSensitiveProcessArgs(args)).toBe(args);
  });
});
