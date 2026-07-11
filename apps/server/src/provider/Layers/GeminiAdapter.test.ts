import { describe, expect, it } from "vitest";

import { resolveGeminiStartInstanceId } from "./GeminiAdapter.ts";

describe("Gemini start account routing", () => {
  it("resolves modelSelection-only identity before launch environment setup", () => {
    expect(
      resolveGeminiStartInstanceId({
        modelSelection: { instanceId: "gemini_work", model: "gemini/model" },
      } as never),
    ).toBe("gemini_work");
  });
});
