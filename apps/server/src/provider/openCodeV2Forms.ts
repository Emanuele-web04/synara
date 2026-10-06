import type { QuestionAnswer, QuestionInfo, QuestionRequest } from "@opencode-ai/sdk/v2";
import {
  v2Array,
  v2Boolean,
  v2Data,
  v2Object,
  v2OptionalObject,
  v2OptionalString,
  v2String,
} from "./openCodeV2Json.ts";

class UnrepresentableFormFieldError extends Error {}

export class UnsupportedOpenCodeV2FormError extends Error {
  constructor(
    message: string,
    readonly sessionID: string,
    readonly requestID: string,
  ) {
    super(message);
    this.name = "UnsupportedOpenCodeV2FormError";
  }
}

function formFields(form: Record<string, unknown>): Record<string, unknown>[] {
  const fields = v2Array(form.fields, "form.fields").map((value) => v2Object(value, "form field"));
  if (fields.length === 0) throw new Error("Invalid OpenCode v2 form: no fields");
  const keys = new Set<string>();
  for (const field of fields) {
    const key = v2String(field.key, "form field.key");
    if (keys.has(key)) throw new Error(`Invalid OpenCode v2 form: duplicate field ${key}`);
    keys.add(key);
    for (const flag of ["hidden", "required", "custom"]) {
      if (field[flag] !== undefined) v2Boolean(field[flag], `form field.${flag}`);
    }
    const conditions = v2Array(field.when ?? [], "form field.when");
    const type = v2String(field.type, "form field.type");
    if (!["string", "boolean", "number", "integer", "multiselect", "external"].includes(type)) {
      throw new Error(`Invalid OpenCode v2 form field type ${type}`);
    }
    if (type === "external" || field.hidden === true || conditions.length > 0) {
      throw new UnrepresentableFormFieldError(
        `Unsupported OpenCode v2 form field ${key}: ${field.type} or conditional/hidden field`,
      );
    }
  }
  return fields;
}

function fieldOptions(
  field: Record<string, unknown>,
): Array<{ label: string; description: string; value: string }> {
  const options = v2Array(field.options ?? [], "form options").map((entry) => {
    const option = v2Object(entry, "form option");
    return {
      label: v2String(option.label, "form option.label"),
      value: v2String(option.value, "form option.value"),
      description: v2OptionalString(option.description) ?? "",
    };
  });
  if (new Set(options.map((option) => option.label)).size !== options.length) {
    throw new UnrepresentableFormFieldError(
      "Unsupported OpenCode v2 form: duplicate option labels",
    );
  }
  return options;
}

function formQuestions(form: Record<string, unknown>): QuestionInfo[] {
  return formFields(form).map((field) => {
    const title = v2OptionalString(field.title) ?? v2String(field.key, "field.key");
    return {
      header: title.slice(0, 30),
      question: v2OptionalString(field.description) ?? title,
      options:
        field.type === "boolean"
          ? [
              { label: "Yes", description: "" },
              { label: "No", description: "" },
            ]
          : fieldOptions(field).map(({ label, description }) => ({ label, description })),
      multiple: field.type === "multiselect",
      custom: field.type === "boolean" ? false : field.custom !== false,
    };
  });
}

export function normalizeOpenCodeV2Form(value: unknown): QuestionRequest {
  const form = v2Object(v2Data(value), "form");
  const id = v2String(form.id, "form.id");
  const sessionID = v2String(form.sessionID, "form.sessionID");
  const metadata = v2OptionalObject(form.metadata);
  const source = v2OptionalObject(metadata.source);
  let questions: QuestionInfo[];
  try {
    questions = formQuestions(form);
  } catch (error) {
    if (error instanceof UnrepresentableFormFieldError) {
      throw new UnsupportedOpenCodeV2FormError(error.message, sessionID, id);
    }
    throw error;
  }
  return {
    id,
    sessionID,
    questions,
    ...(source.type === "tool"
      ? {
          tool: {
            messageID: v2String(source.messageID, "form source.messageID"),
            callID: v2String(source.id, "form source.id"),
          },
        }
      : {}),
  };
}

export function normalizeOpenCodeV2Questions(value: unknown): QuestionRequest[] {
  return v2Array(value, "forms").map(normalizeOpenCodeV2Form);
}

export function normalizeOpenCodeV2FormReply(value: unknown, answer: unknown): QuestionAnswer[] {
  const form = v2Object(v2Data(value), "form");
  const submitted = v2Object(answer, "form reply");
  return formFields(form).map((field) => {
    const key = v2String(field.key, "form field.key");
    const value = submitted[key];
    if (value === undefined) return [];
    const values = Array.isArray(value) ? value : [value];
    const options = fieldOptions(field);
    return values.map((item) => {
      if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")
        throw new Error("Invalid OpenCode v2 form reply value");
      if (typeof item === "boolean") return item ? "Yes" : "No";
      const text = String(item);
      return options.find((option) => option.value === text)?.label ?? text;
    });
  });
}

export function normalizeOpenCodeV2FormAnswers(
  value: unknown,
  answers: QuestionAnswer[],
): Record<string, string | number | boolean | string[]> {
  const form = v2Object(v2Data(value), "form");
  const fields = formFields(form);
  if (answers.length !== fields.length)
    throw new Error("Invalid OpenCode v2 form reply: answer count does not match fields");
  const result: Array<[string, string | number | boolean | string[]]> = [];
  for (const [index, field] of fields.entries()) {
    const key = v2String(field.key, "form field.key");
    const selected = v2Array(answers[index], "form answers").map((entry) =>
      v2String(entry, "form answer"),
    );
    let usingDefault = false;
    if (selected.length === 0) {
      if (field.default !== undefined) {
        // Defaults are converted through the same validation as user answers.
        usingDefault = true;
        const defaults = Array.isArray(field.default) ? field.default : [field.default];
        selected.push(...defaults.map(String));
      } else if (field.required === true) {
        throw new Error(`Invalid OpenCode v2 form reply: ${key} is required`);
      } else {
        continue;
      }
    }
    if (field.type !== "multiselect" && selected.length !== 1)
      throw new Error(`Invalid OpenCode v2 form reply: ${key} expects one answer`);
    const options = fieldOptions(field);
    const converted = selected.map((answer) => {
      // The UI returns labels, while the wire schema stores raw values in defaults.
      const option = usingDefault
        ? options.find((entry) => entry.value === answer)
        : (options.find((entry) => entry.label === answer) ??
          options.find((entry) => entry.value === answer));
      if (option) return option.value;
      if (options.length > 0 && field.custom === false)
        throw new Error(`Invalid OpenCode v2 form reply: unknown option for ${key}`);
      return answer;
    });
    const text = converted[0] ?? "";
    let answer: string | number | boolean | string[];
    if (field.type === "multiselect") {
      answer = converted;
    } else if (field.type === "boolean") {
      if (text !== "Yes" && text !== "No" && text !== "true" && text !== "false")
        throw new Error(`Invalid OpenCode v2 form reply: ${key} expects a boolean`);
      answer = text === "Yes" || text === "true";
    } else if (field.type === "number" || field.type === "integer") {
      answer = Number(text);
      if (
        text.trim() === "" ||
        !Number.isFinite(answer) ||
        (field.type === "integer" && !Number.isInteger(answer))
      )
        throw new Error(`Invalid OpenCode v2 form reply: ${key} expects ${field.type}`);
    } else {
      answer = text;
    }
    result.push([key, answer]);
  }
  return Object.fromEntries(result);
}
