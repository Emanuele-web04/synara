// FILE: textGenerationShared.test.ts
// Purpose: Verifies shared structured text-generation parsing helpers.
// Layer: Server git utility test
// Depends on: Effect schema decoding and automation completion prompt schemas.

import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildAutomationCompletionEvaluationPrompt,
  buildWalkthroughPrompt,
  buildAutomationIntentPrompt,
  decodeStructuredTextGenerationOutput,
} from "./textGenerationShared.ts";
import { stripNullOptionalFields, toJsonSchemaObject } from "./strictJsonSchema.ts";

// OpenAI strict structured-output mode rejects a schema whose object `required` omits any
// property, or that uses `allOf`. Assert the codex-bound JSON Schema satisfies both, recursively.
function assertStrict(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => assertStrict(entry, `${path}[${String(index)}]`));
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  expect(record, `allOf must not appear at ${path}`).not.toHaveProperty("allOf");
  const properties = record["properties"];
  if (record["type"] === "object" && properties !== null && typeof properties === "object") {
    const required = Array.isArray(record["required"]) ? (record["required"] as string[]) : [];
    expect(required.toSorted(), `required must list every property at ${path}`).toEqual(
      Object.keys(properties as Record<string, unknown>).toSorted(),
    );
  }
  for (const [, value] of Object.entries(record)) {
    assertStrict(value, path);
  }
}

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

  it("asks automation intent generation for detailed prompts without invented context", () => {
    const { prompt } = buildAutomationIntentPrompt({
      message: "every 6h check the site",
      nowIso: "2026-06-21T20:00:00.000Z",
    });

    expect(prompt).toContain("detailed, self-contained recurring instruction");
    expect(prompt).toContain("Do not invent repo-specific files, commands");
    expect(prompt).toContain("schedule, stop, or run-count scaffolding");
    expect(prompt).toContain("maxIterations: positive integer");
    expect(prompt).toContain("Task prompt quality checklist");
    expect(prompt).toContain("Decision gates");
    expect(prompt).toContain("commit/push only if there is an actual count change");
  });
});

describe("toJsonSchemaObject (OpenAI strict mode)", () => {
  it("marks every object property required and drops allOf for optional + constrained fields", () => {
    const schema = Schema.Struct({
      title: Schema.String,
      note: Schema.optional(Schema.String),
      count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      nested: Schema.Struct({ flag: Schema.optional(Schema.Boolean) }),
    });
    assertStrict(toJsonSchemaObject(schema), "$");
  });

  it("produces a strict schema for the real walkthrough output (regression: missing 'motivation')", () => {
    const { outputSchemaJson } = buildWalkthroughPrompt({ patch: "" });
    assertStrict(toJsonSchemaObject(outputSchemaJson), "$");
  });
});

describe("stripNullOptionalFields", () => {
  it("drops null values for optional keys but keeps explicit NullOr nulls", () => {
    const schema = Schema.Struct({
      kept: Schema.String,
      optional: Schema.optional(Schema.String),
      nullable: Schema.NullOr(Schema.String),
    });
    const result = stripNullOptionalFields(schema, {
      kept: "x",
      optional: null,
      nullable: null,
    }) as Record<string, unknown>;
    expect(result).not.toHaveProperty("optional");
    expect(result["kept"]).toBe("x");
    expect(result["nullable"]).toBeNull();
  });
});
