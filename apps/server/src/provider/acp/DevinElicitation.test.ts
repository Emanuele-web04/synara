/**
 * Tests for Devin ACP elicitation helpers.
 *
 * @module DevinElicitationTest
 */
import { describe, it, assert } from "@effect/vitest";

import {
  elicitationFormToUserInputQuestions,
  userInputAnswersToElicitationContent,
  validateUserInputAnswersForElicitation,
} from "./DevinElicitation.ts";

const baseForm = {
  mode: "form" as const,
  message: "What should I do?",
  sessionId: "s1",
};

describe("elicitationFormToUserInputQuestions", () => {
  it("maps a string enum property to options and correct ids/headers", () => {
    const questions = elicitationFormToUserInputQuestions({
      ...baseForm,
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            enum: ["a", "b"],
            title: "Pick one",
            description: "Select an option",
          },
        },
      },
    });

    assert.strictEqual(questions.length, 1);
    assert.strictEqual(questions[0]!.id, "choice");
    assert.strictEqual(questions[0]!.header, "Pick one");
    assert.strictEqual(questions[0]!.question, "Select an option");
    assert.deepStrictEqual(questions[0]!.options, [
      { label: "a", description: "a" },
      { label: "b", description: "b" },
    ]);
    assert.strictEqual(questions[0]!.multiSelect, false);
  });

  it("maps a string oneOf property to titled options", () => {
    const questions = elicitationFormToUserInputQuestions({
      ...baseForm,
      requestedSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            oneOf: [
              { const: "bug", title: "Bug fix" },
              { const: "feature", title: "New feature" },
            ],
          },
        },
      },
    });

    assert.strictEqual(questions.length, 1);
    assert.deepStrictEqual(questions[0]!.options, [
      { label: "bug", description: "Bug fix" },
      { label: "feature", description: "New feature" },
    ]);
  });

  it("maps a boolean property to Yes/No options", () => {
    const questions = elicitationFormToUserInputQuestions({
      ...baseForm,
      requestedSchema: {
        type: "object",
        properties: {
          shouldContinue: { type: "boolean", title: "Continue?" },
        },
      },
    });

    assert.strictEqual(questions.length, 1);
    assert.strictEqual(questions[0]!.id, "shouldContinue");
    assert.deepStrictEqual(questions[0]!.options, [
      { label: "Yes", description: "Yes" },
      { label: "No", description: "No" },
    ]);
    assert.strictEqual(questions[0]!.multiSelect, false);
  });

  it("maps an array-of-enum to multiSelect: true", () => {
    const questions = elicitationFormToUserInputQuestions({
      ...baseForm,
      requestedSchema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            title: "Tags",
            items: { enum: ["ux", "api", "db"], type: "string" },
          },
        },
      },
    });

    assert.strictEqual(questions.length, 1);
    assert.strictEqual(questions[0]!.id, "tags");
    assert.strictEqual(questions[0]!.multiSelect, true);
    assert.deepStrictEqual(questions[0]!.options, [
      { label: "ux", description: "ux" },
      { label: "api", description: "api" },
      { label: "db", description: "db" },
    ]);
  });

  it("maps an array-of-titled-enum to multiSelect: true", () => {
    const questions = elicitationFormToUserInputQuestions({
      ...baseForm,
      requestedSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            title: "Files",
            items: {
              anyOf: [
                { const: "f1", title: "File One" },
                { const: "f2", title: "File Two" },
              ],
            },
          },
        },
      },
    });

    assert.strictEqual(questions.length, 1);
    assert.strictEqual(questions[0]!.multiSelect, true);
    assert.deepStrictEqual(questions[0]!.options, [
      { label: "f1", description: "File One" },
      { label: "f2", description: "File Two" },
    ]);
  });

  it("uses the OK fallback for a free-form string property", () => {
    const questions = elicitationFormToUserInputQuestions({
      ...baseForm,
      requestedSchema: {
        type: "object",
        properties: {
          note: { type: "string", title: "Note" },
        },
      },
    });

    assert.strictEqual(questions.length, 1);
    assert.deepStrictEqual(questions[0]!.options, [{ label: "OK", description: "Continue" }]);
  });

  it("uses the OK fallback for a number property", () => {
    const questions = elicitationFormToUserInputQuestions({
      ...baseForm,
      message: "Enter count",
      requestedSchema: {
        type: "object",
        properties: {
          count: { type: "integer", title: "Count", description: "How many" },
        },
      },
    });

    assert.strictEqual(questions.length, 1);
    assert.strictEqual(questions[0]!.question, "How many");
    assert.deepStrictEqual(questions[0]!.options, [{ label: "OK", description: "Continue" }]);
  });

  it("returns a synthetic question when properties is empty", () => {
    const questions = elicitationFormToUserInputQuestions({
      ...baseForm,
      message: "What now?",
      requestedSchema: { type: "object" },
    });

    assert.strictEqual(questions.length, 1);
    assert.strictEqual(questions[0]!.id, "response");
    assert.strictEqual(questions[0]!.header, "Devin");
    assert.strictEqual(questions[0]!.question, "What now?");
    assert.deepStrictEqual(questions[0]!.options, [{ label: "OK", description: "Continue" }]);
  });

  it("falls back title to key and description to message", () => {
    const questions = elicitationFormToUserInputQuestions({
      ...baseForm,
      message: "Proceed?",
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean" },
        },
      },
    });

    assert.strictEqual(questions.length, 1);
    assert.strictEqual(questions[0]!.header, "confirm");
    assert.strictEqual(questions[0]!.question, "Proceed?");
  });
});

describe("userInputAnswersToElicitationContent", () => {
  const boolForm: Extract<import("effect-acp/schema").ElicitationRequest, { mode: "form" }> = {
    ...baseForm,
    requestedSchema: {
      type: "object",
      properties: {
        shouldContinue: { type: "boolean" },
      },
    },
  };

  it('round-trips boolean "Yes" to true', () => {
    const content = userInputAnswersToElicitationContent(boolForm, {
      shouldContinue: "Yes",
    });
    assert.deepStrictEqual(content, { shouldContinue: true });
  });

  it('round-trips boolean "No" to false', () => {
    const content = userInputAnswersToElicitationContent(boolForm, {
      shouldContinue: "No",
    });
    assert.deepStrictEqual(content, { shouldContinue: false });
  });

  it('round-trips boolean "true" to true', () => {
    const content = userInputAnswersToElicitationContent(boolForm, {
      shouldContinue: "true",
    });
    assert.deepStrictEqual(content, { shouldContinue: true });
  });

  it("parses a number answer to a number", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          count: { type: "integer" as const },
        },
      },
    };

    const content = userInputAnswersToElicitationContent(form, { count: "42" });
    assert.deepStrictEqual(content, { count: 42 });
  });

  it("skips non-numeric number answers", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          count: { type: "integer" as const },
        },
      },
    };

    const content = userInputAnswersToElicitationContent(form, { count: "abc" });
    assert.deepStrictEqual(content, {});
  });

  it("passes array values through", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          tags: {
            type: "array" as const,
            items: { enum: ["a", "b"], type: "string" as const },
          },
        },
      },
    };

    const content = userInputAnswersToElicitationContent(form, {
      tags: ["a", "b"],
    });
    assert.deepStrictEqual(content, { tags: ["a", "b"] });
  });

  it("wraps lone string in array for array property", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          tags: {
            type: "array" as const,
            items: { enum: ["a", "b"], type: "string" as const },
          },
        },
      },
    };

    const content = userInputAnswersToElicitationContent(form, { tags: "a" });
    assert.deepStrictEqual(content, { tags: ["a"] });
  });

  it("passes through string answers for string properties", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          note: { type: "string" as const },
        },
      },
    };

    const content = userInputAnswersToElicitationContent(form, { note: "hello" });
    assert.deepStrictEqual(content, { note: "hello" });
  });

  it("joins array string answers with comma for string property", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          note: { type: "string" as const },
        },
      },
    };

    const content = userInputAnswersToElicitationContent(form, {
      note: ["hello", "world"],
    });
    assert.deepStrictEqual(content, { note: "hello, world" });
  });

  it("skips null answers", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          note: { type: "string" as const },
        },
      },
    };

    const content = userInputAnswersToElicitationContent(form, {
      note: null,
    });
    assert.deepStrictEqual(content, {});
  });

  it("includes the synthetic response key when properties was empty", () => {
    const form = {
      ...baseForm,
      message: "What now?",
      requestedSchema: { type: "object" as const },
    };

    const content = userInputAnswersToElicitationContent(form, {
      response: "continue",
    });
    assert.deepStrictEqual(content, { response: "continue" });
  });

  it("drops unknown keys when properties exist", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          note: { type: "string" as const },
        },
      },
    };

    const content = userInputAnswersToElicitationContent(form, {
      note: "ok",
      unknown: "drop-me",
    });
    assert.deepStrictEqual(content, { note: "ok" });
  });

  it("handles multiple properties with mixed types", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
          count: { type: "number" as const },
          flag: { type: "boolean" as const },
          tags: {
            type: "array" as const,
            items: { enum: ["a", "b"], type: "string" as const },
          },
        },
      },
    };

    const content = userInputAnswersToElicitationContent(form, {
      name: "test",
      count: "99",
      flag: "Yes",
      tags: ["a"],
    });
    assert.deepStrictEqual(content, {
      name: "test",
      count: 99,
      flag: true,
      tags: ["a"],
    });
  });
});

describe("validateUserInputAnswersForElicitation", () => {
  const enumForm = {
    ...baseForm,
    requestedSchema: {
      type: "object" as const,
      properties: {
        choice: { type: "string" as const, enum: ["a", "b"] },
      },
    },
  };

  it("rejects a string enum value not in the enum", () => {
    const result = validateUserInputAnswersForElicitation(enumForm, {
      choice: "not-allowed",
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.issues.length, 1);
    assert.match(result.issues[0]!, /must be one of: a, b/);
  });

  it("accepts a string enum value in the enum", () => {
    const result = validateUserInputAnswersForElicitation(enumForm, { choice: "a" });
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.issues, []);
  });

  it("rejects a string oneOf value not in the allowed constants", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          kind: {
            type: "string" as const,
            oneOf: [
              { const: "bug", title: "Bug fix" },
              { const: "feature", title: "New feature" },
            ],
          },
        },
      },
    };

    const invalid = validateUserInputAnswersForElicitation(form, { kind: "chore" });
    assert.strictEqual(invalid.valid, false);
    assert.match(invalid.issues[0]!, /must be one of: bug, feature/);

    const valid = validateUserInputAnswersForElicitation(form, { kind: "feature" });
    assert.strictEqual(valid.valid, true);
  });

  it("rejects an array enum value containing an unlisted item", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          tags: {
            type: "array" as const,
            items: { enum: ["ux", "api"], type: "string" as const },
          },
        },
      },
    };

    const invalid = validateUserInputAnswersForElicitation(form, {
      tags: ["ux", "db"],
    });
    assert.strictEqual(invalid.valid, false);
    assert.match(invalid.issues[0]!, /disallowed values: db/);

    const valid = validateUserInputAnswersForElicitation(form, { tags: ["ux"] });
    assert.strictEqual(valid.valid, true);
  });

  it("rejects an array anyOf value containing an unlisted item", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          files: {
            type: "array" as const,
            items: {
              anyOf: [
                { const: "f1", title: "File One" },
                { const: "f2", title: "File Two" },
              ],
            },
          },
        },
      },
    };

    const invalid = validateUserInputAnswersForElicitation(form, { files: ["f3"] });
    assert.strictEqual(invalid.valid, false);
    assert.match(invalid.issues[0]!, /disallowed values: f3/);
  });

  it("wraps a lone string for an array property before checking allowed items", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          tags: {
            type: "array" as const,
            items: { enum: ["a", "b"], type: "string" as const },
          },
        },
      },
    };

    assert.strictEqual(validateUserInputAnswersForElicitation(form, { tags: "a" }).valid, true);
    assert.strictEqual(validateUserInputAnswersForElicitation(form, { tags: "x" }).valid, false);
  });

  it("rejects missing required answers", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          choice: { type: "string" as const, enum: ["a", "b"] },
        },
        required: ["choice"],
      },
    };

    const missing = validateUserInputAnswersForElicitation(form, {});
    assert.strictEqual(missing.valid, false);
    assert.match(missing.issues[0]!, /Missing required answer 'choice'/);

    const nulled = validateUserInputAnswersForElicitation(form, { choice: null });
    assert.strictEqual(nulled.valid, false);
    assert.match(nulled.issues[0]!, /Missing required answer 'choice'/);
  });

  it("allows null answers for optional properties", () => {
    const result = validateUserInputAnswersForElicitation(enumForm, { choice: null });
    assert.strictEqual(result.valid, true);
  });

  it("rejects non-integer text for an integer property", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          count: { type: "integer" as const },
        },
      },
    };

    const nonNumeric = validateUserInputAnswersForElicitation(form, { count: "abc" });
    assert.strictEqual(nonNumeric.valid, false);
    assert.match(nonNumeric.issues[0]!, /must be a finite number/);

    const fractional = validateUserInputAnswersForElicitation(form, { count: "4.5" });
    assert.strictEqual(fractional.valid, false);
    assert.match(fractional.issues[0]!, /must be an integer/);

    const valid = validateUserInputAnswersForElicitation(form, { count: "42" });
    assert.strictEqual(valid.valid, true);
  });

  it("rejects a non-boolean answer for a boolean property", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          flag: { type: "boolean" as const },
        },
      },
    };

    const invalid = validateUserInputAnswersForElicitation(form, { flag: "maybe" });
    assert.strictEqual(invalid.valid, false);
    assert.match(invalid.issues[0]!, /must be Yes, No, true, or false/);

    assert.strictEqual(validateUserInputAnswersForElicitation(form, { flag: "Yes" }).valid, true);
    assert.strictEqual(validateUserInputAnswersForElicitation(form, { flag: "false" }).valid, true);
  });

  it("rejects unknown keys when properties exist", () => {
    const result = validateUserInputAnswersForElicitation(enumForm, {
      choice: "a",
      extra: "nope",
    });
    assert.strictEqual(result.valid, false);
    assert.match(result.issues[0]!, /Unknown answer key 'extra'/);
  });

  it("accepts the synthetic response key when properties are empty", () => {
    const form = {
      ...baseForm,
      requestedSchema: { type: "object" as const },
    };

    assert.strictEqual(
      validateUserInputAnswersForElicitation(form, { response: "continue" }).valid,
      true,
    );
    assert.strictEqual(validateUserInputAnswersForElicitation(form, { other: "x" }).valid, false);
  });

  it("accepts free-form string answers without enum constraints", () => {
    const form = {
      ...baseForm,
      requestedSchema: {
        type: "object" as const,
        properties: {
          note: { type: "string" as const },
        },
      },
    };

    const result = validateUserInputAnswersForElicitation(form, { note: "anything goes" });
    assert.strictEqual(result.valid, true);
  });
});
