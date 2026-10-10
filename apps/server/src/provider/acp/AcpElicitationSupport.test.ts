// FILE: AcpElicitationSupport.test.ts
// Purpose: Verifies ACP form schemas and Synara answers round-trip without losing primitive types.
// Layer: Provider ACP tests
// Depends on: AcpElicitationSupport.

import { describe, expect, it } from "vitest";

import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
} from "./AcpElicitationSupport.ts";

const request = {
  mode: "form" as const,
  sessionId: "session-1",
  message: "Choose deployment settings",
  requestedSchema: {
    type: "object" as const,
    properties: {
      environment: {
        type: "string" as const,
        title: "Environment",
        description: "Where should this deploy?",
        enum: ["Staging", "Production"],
      },
      replicas: {
        type: "integer" as const,
        title: "Replicas",
        description: "How many replicas?",
      },
      notify: {
        type: "boolean" as const,
        title: "Notify",
        description: "Send a notification?",
      },
    },
  },
};

const droidRequest = {
  mode: "form" as const,
  sessionId: "session-1",
  message: "Choose an approach",
  requestedSchema: {
    type: "object" as const,
    required: ["single", "multiple"],
    properties: {
      single: {
        type: "string" as const,
        title: "Approach",
        oneOf: [
          { const: "option_0", title: "First approach" },
          { const: "option_1", title: "Second approach" },
          { const: "other", title: "Other answer" },
        ],
      },
      single_other: { type: "string" as const, title: "Approach: Other answer" },
      multiple: {
        type: "array" as const,
        items: {
          anyOf: [
            { const: "option_0", title: "First feature" },
            { const: "option_1", title: "Second feature" },
            { const: "other", title: "Other answer" },
          ],
        },
      },
      multiple_other: { type: "string" as const, title: "Features: Other answer" },
    },
  },
};

describe("ACP elicitation mapping", () => {
  it("maps primitive form fields to Synara questions", () => {
    expect(elicitationQuestionsFromRequest(request)).toEqual([
      {
        id: "environment",
        header: "Environment",
        question: "Where should this deploy?",
        options: [
          { label: "Staging", description: "Staging" },
          { label: "Production", description: "Production" },
        ],
        multiSelect: false,
      },
      expect.objectContaining({ id: "replicas", options: [] }),
      expect.objectContaining({
        id: "notify",
        options: [
          { label: "Yes", description: "Yes" },
          { label: "No", description: "No" },
        ],
      }),
    ]);
  });

  it("coerces submitted text back to the ACP property's native type", () => {
    expect(
      elicitationResponseFromAnswers(request, {
        environment: "Production",
        replicas: "3",
        notify: "Yes",
      }),
    ).toEqual({
      action: "accept",
      content: { environment: "Production", replicas: 3, notify: true },
    });
  });

  it("folds other-answer companion fields into their real questions", () => {
    const questions = elicitationQuestionsFromRequest(droidRequest);
    expect(questions.map(({ id }) => id)).toEqual(["single", "multiple"]);
    expect(questions[0]?.options).toEqual([
      { label: "option_0", description: "First approach" },
      { label: "option_1", description: "Second approach" },
    ]);
    expect(questions[1]).toMatchObject({ header: "Question 2", multiSelect: true });
    expect(questions[1]?.options.map(({ label }) => label)).toEqual(["option_0", "option_1"]);
  });

  it("encodes custom single-select text using the provider's other sentinel", () => {
    expect(elicitationResponseFromAnswers(droidRequest, { single: "A custom approach" })).toEqual({
      action: "accept",
      content: { single: "other", single_other: "A custom approach" },
    });
  });

  it("preserves known selections while encoding multi-select custom text", () => {
    expect(
      elicitationResponseFromAnswers(droidRequest, {
        multiple: ["option_1", "A custom feature", "Another feature"],
      }),
    ).toEqual({
      action: "accept",
      content: {
        multiple: ["option_1", "other"],
        multiple_other: "A custom feature\nAnother feature",
      },
    });
  });

  it("leaves option-only submissions unchanged and ignores stale companion text", () => {
    expect(
      elicitationResponseFromAnswers(droidRequest, {
        single: "option_0",
        single_other: ".",
        multiple: ["option_1", "option_0"],
        multiple_other: ".",
      }),
    ).toEqual({
      action: "accept",
      content: { single: "option_0", multiple: ["option_1", "option_0"] },
    });
  });

  it("accepts legacy direct companion answers when other is selected", () => {
    expect(
      elicitationResponseFromAnswers(droidRequest, {
        single: "other",
        single_other: "Legacy single answer",
        multiple: ["option_0", "other"],
        multiple_other: "Legacy multiple answer",
      }),
    ).toEqual({
      action: "accept",
      content: {
        single: "other",
        single_other: "Legacy single answer",
        multiple: ["option_0", "other"],
        multiple_other: "Legacy multiple answer",
      },
    });
  });

  it("drops bare other sentinels without discarding valid multi-select choices", () => {
    expect(
      elicitationResponseFromAnswers(droidRequest, {
        single: "other",
        single_other: " ",
        multiple: ["other", "option_1"],
      }),
    ).toEqual({ action: "accept", content: { multiple: ["option_1"] } });
  });

  it("does not fold unrelated fields when either convention marker is missing", () => {
    const ordinaryRequest = {
      ...droidRequest,
      requestedSchema: {
        type: "object" as const,
        properties: {
          choice: { type: "string" as const, enum: ["first", "other"] },
          text: { type: "string" as const },
          text_other: { type: "string" as const },
        },
      },
    };
    expect(elicitationQuestionsFromRequest(ordinaryRequest).map(({ id }) => id)).toEqual([
      "choice",
      "text",
      "text_other",
    ]);
    expect(
      elicitationResponseFromAnswers(ordinaryRequest, {
        choice: "other",
        text: "Custom",
        text_other: "Independent field",
      }),
    ).toEqual({
      action: "accept",
      content: { choice: "other", text: "Custom", text_other: "Independent field" },
    });
  });
});
