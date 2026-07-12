import { describe, expect, it } from "vitest";

import type * as EffectAcpSchema from "effect-acp/schema";

import { applySessionConfigOptionValue, assistantItemId } from "./AcpSessionRuntime.ts";

describe("assistantItemId", () => {
  // Format contract only — distinct runtimeInstanceId wiring is covered by
  // AcpJsonRpcConnection.test.ts ("assigns distinct fallback assistant item ids...").
  it("produces distinct ids across runtime instances with the same session id and segment index", () => {
    const sessionId = "session-1";
    const a = assistantItemId(sessionId, "aaaa1111", 0);
    const b = assistantItemId(sessionId, "bbbb2222", 0);
    expect(a).not.toBe(b);
    expect(a).toBe("assistant:session-1:aaaa1111:segment:0");
    expect(b).toBe("assistant:session-1:bbbb2222:segment:0");
  });
});

describe("applySessionConfigOptionValue", () => {
  it("updates the requested option while retaining the rest of the inventory", () => {
    const configOptions = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "gpt-5.5",
        options: [
          { value: "gpt-5.5", name: "GPT-5.5" },
          { value: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
        ],
      },
      {
        id: "thinking",
        name: "Thinking",
        type: "boolean",
        currentValue: false,
      },
    ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

    expect(applySessionConfigOptionValue(configOptions, "model", "gpt-5.6-luna")).toEqual([
      { ...configOptions[0], currentValue: "gpt-5.6-luna" },
      configOptions[1],
    ]);
    expect(configOptions[0]?.currentValue).toBe("gpt-5.5");
  });

  it("does not apply a value with the wrong option type", () => {
    const configOptions = [
      {
        id: "thinking",
        name: "Thinking",
        type: "boolean",
        currentValue: false,
      },
    ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

    expect(applySessionConfigOptionValue(configOptions, "thinking", "true")).toEqual(configOptions);
  });
});
