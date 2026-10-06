import { describe, expect, it } from "vitest";
import { UnsupportedOpenCodeV2FormError } from "./openCodeV2Forms.ts";
import {
  normalizeOpenCodeV2Form,
  normalizeOpenCodeV2FormAnswers,
  normalizeOpenCodeV2FormReply,
  normalizeOpenCodeV2Permission,
} from "./openCodeV2Data.ts";

describe("OpenCode v2 approvals and forms", () => {
  const form = {
    id: "frm_1",
    sessionID: "ses_1",
    title: "Choices",
    fields: [
      {
        key: "branch",
        type: "string",
        title: "Branch",
        custom: false,
        options: [
          { label: "Main branch", value: "main" },
          { label: "Feature branch", value: "feature" },
        ],
      },
      { key: "count", type: "integer", title: "Count" },
      { key: "confirm", type: "boolean", title: "Continue" },
      {
        key: "features",
        type: "multiselect",
        title: "Features",
        options: [
          { label: "Tools", value: "tools" },
          { label: "Images", value: "images" },
        ],
        custom: false,
      },
    ],
  };

  it("keeps approval resources and session persistence opt-in", () => {
    expect(
      normalizeOpenCodeV2Permission({
        id: "per_1",
        sessionID: "ses_1",
        action: "bash",
        resources: ["git status"],
        save: ["git *"],
        source: { type: "tool", messageID: "msg_1", id: "call_1" },
        message: "Run git?",
      }),
    ).toMatchObject({
      permission: "bash",
      patterns: ["git status"],
      always: ["git *"],
      tool: { messageID: "msg_1", callID: "call_1" },
      metadata: { message: "Run git?" },
    });
    expect(
      normalizeOpenCodeV2Permission({
        id: "per_1",
        sessionID: "ses_1",
        action: "bash",
        resources: [],
      }).always,
    ).toEqual([]);
  });

  it("roundtrips labels and typed answers without dropping field keys", () => {
    expect(normalizeOpenCodeV2Form(form).questions[0]?.options).toEqual([
      { label: "Main branch", description: "" },
      { label: "Feature branch", description: "" },
    ]);
    const answers = [["Feature branch"], ["3"], ["No"], ["Tools", "Images"]];
    const reply = normalizeOpenCodeV2FormAnswers(form, answers);
    expect(reply).toEqual({
      branch: "feature",
      count: 3,
      confirm: false,
      features: ["tools", "images"],
    });
    expect(normalizeOpenCodeV2FormReply(form, reply)).toEqual(answers);
  });

  it("prioritizes displayed labels over another option's wire value", () => {
    const collidingForm = {
      ...form,
      fields: [
        {
          key: "choice",
          type: "string",
          custom: false,
          options: [
            { label: "First", value: "Second" },
            { label: "Second", value: "actual" },
          ],
          default: "Second",
        },
      ],
    };
    expect(normalizeOpenCodeV2FormAnswers(collidingForm, [["Second"]])).toEqual({
      choice: "actual",
    });
    expect(normalizeOpenCodeV2FormReply(collidingForm, { choice: "actual" })).toEqual([["Second"]]);
    expect(normalizeOpenCodeV2FormAnswers(collidingForm, [[]])).toEqual({ choice: "Second" });
  });

  it("rejects unrepresentable forms and invalid answers before sending replies", () => {
    expect(() =>
      normalizeOpenCodeV2Form({
        ...form,
        fields: [{ key: "external", type: "external", url: "https://example.com" }],
      }),
    ).toThrow("Unsupported");
    expect(() =>
      normalizeOpenCodeV2Form({
        ...form,
        fields: [{ key: "conditional", type: "string", when: [{ key: "other" }] }],
      }),
    ).toThrow("Unsupported");
    expect(() => normalizeOpenCodeV2FormAnswers(form, [["Unknown"], ["3"], ["No"], []])).toThrow(
      "unknown option",
    );
    expect(() =>
      normalizeOpenCodeV2FormAnswers(form, [["Main branch"], ["3.5"], ["No"], []]),
    ).toThrow("expects integer");
    expect(() => normalizeOpenCodeV2FormAnswers(form, [["Main branch"]])).toThrow("answer count");
  });

  it("identifies unsupported forms with their owning session and request", () => {
    for (const field of [
      { key: "external", type: "external", url: "https://example.com" },
      { key: "hidden", type: "string", hidden: true },
      { key: "conditional", type: "string", when: [{ key: "prior", op: "eq", value: true }] },
      {
        key: "choice",
        type: "string",
        options: [
          { label: "Same", value: "a" },
          { label: "Same", value: "b" },
        ],
      },
    ]) {
      let failure: unknown;
      try {
        normalizeOpenCodeV2Form({ ...form, fields: [field] });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(UnsupportedOpenCodeV2FormError);
      expect(failure).toMatchObject({ sessionID: "ses_1", requestID: "frm_1" });
    }
    let invalid: unknown;
    try {
      normalizeOpenCodeV2Form({ ...form, fields: [{ key: "bad", type: "string", hidden: "yes" }] });
    } catch (error) {
      invalid = error;
    }
    expect(invalid).toBeInstanceOf(Error);
    expect(invalid).not.toBeInstanceOf(UnsupportedOpenCodeV2FormError);
  });
});
