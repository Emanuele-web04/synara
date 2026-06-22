// FILE: textGenerationShared.test.ts
// Purpose: Verifies shared structured text-generation parsing helpers.
// Layer: Server git utility test
// Depends on: Effect schema decoding and automation completion prompt schemas.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildAutomationCompletionEvaluationPrompt,
  decodeStructuredTextGenerationOutput,
} from "./textGenerationShared.ts";

describe("textGenerationShared", () => {
  it("accepts out-of-range automation completion confidence for downstream clamping", async () => {
    const { outputSchemaJson } = buildAutomationCompletionEvaluationPrompt({
      automationName: "Watch PR",
      automationPrompt: "Check the PR.",
      stopWhen: "the PR is ready",
      runUserMessage: "Check the PR.",
      runAssistantText: "The PR is ready.",
    });

    const result = await Effect.runPromise(
      decodeStructuredTextGenerationOutput({
        schema: outputSchemaJson,
        raw: JSON.stringify({
          stopMatched: true,
          confidence: 1.2,
          reason: "The run says the PR is ready.",
        }),
        operation: "automation completion evaluation",
        providerLabel: "Test provider",
      }),
    );

    expect(result).toEqual({
      stopMatched: true,
      confidence: 1.2,
      reason: "The run says the PR is ready.",
    });
  });
});
