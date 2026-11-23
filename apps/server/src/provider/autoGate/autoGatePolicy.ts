/**
 * Pure decision logic for the local Auto gate (ProCreations/auto-0.4b). The
 * model backend lives in AutoGate.ts; everything here is unit-testable without
 * ONNX or a downloaded model.
 */
import type { AutoGateThresholdPreset } from "@synara/contracts";

export interface AutoGateThresholds {
  readonly allowBelow: number;
  readonly denyAbove: number;
}

export function autoGateThresholdsForPreset(preset: AutoGateThresholdPreset): AutoGateThresholds {
  switch (preset) {
    case "strict":
      return { allowBelow: 0.4, denyAbove: 0.9 };
    case "permissive":
      return { allowBelow: 0.1, denyAbove: 0.6 };
    case "balanced":
      return { allowBelow: 0.25, denyAbove: 0.75 };
  }
}

/**
 * Actions that always reach a human card even when the classifier is confident.
 * Patterns are matched case-insensitively against the tool title plus rawInput.
 */
const ALWAYS_PROMPT_PATTERNS: ReadonlyArray<RegExp> = [
  /\brm\s+(-[^\s]*r[^\s]*\s+)?-f\b|\brm\s+-[^\s]*f[^\s]*r[^\s]*\b|\brm\s+-r[f]?\s/iu,
  /\bgit\s+push\b/iu,
  /\bgit\s+reset\s+--hard\b/iu,
  /\bsudo\b/iu,
  /~?\/\.ssh\//u,
  /~?\/\.aws\//u,
  /(?:^|[/\\])\.env\b|\b\.env\.\w+\b/iu,
  /\bcurl\b[^|]*\|\s*(?:ba|z)?sh\b|\bwget\b[^|]*\|\s*(?:ba|z)?sh\b/iu,
  /\bchmod\s+-R\s+0?777\b/iu,
  /\bmkfs\b/iu,
];

export function isAlwaysPromptToolCall(input: {
  readonly title?: string | undefined;
  readonly rawInput?: unknown;
}): boolean {
  const text = `${input.title ?? ""}\n${stableStringify(input.rawInput)}`;
  return ALWAYS_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

export function stableStringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

const MAX_INPUT_CHARS = 12_000;
const MAX_HISTORY_CHARS = 4_000;

/** Classifier input format (matches the model's documented fields). */
export function buildGateInputText(input: {
  readonly toolCall: { readonly title?: string | undefined; readonly rawInput?: unknown };
  readonly userRequest?: string | undefined;
  readonly history?: string | undefined;
}): string {
  const toolCallJson = stableStringify(input.toolCall.rawInput);
  const toolCall = `{"title": ${JSON.stringify(input.toolCall.title ?? "")}, "input": ${toolCallJson === "" ? "{}" : toolCallJson}}`;
  const userRequest = (input.userRequest ?? "").slice(0, MAX_HISTORY_CHARS);
  const history = (input.history ?? "").slice(-MAX_HISTORY_CHARS);
  return `### PROPOSED TOOL CALL\n${toolCall.slice(0, MAX_INPUT_CHARS)}\n### USER REQUEST\n${userRequest}\n### AGENT HISTORY\n${history}`;
}

export type AutoGateVerdict =
  | { readonly kind: "allow"; readonly pDeny: number }
  | { readonly kind: "deny"; readonly pDeny: number }
  | {
      readonly kind: "prompt";
      readonly pDeny: number;
      readonly reason: "uncertain-band" | "always-prompt";
    };

export function decideAutoGate(input: {
  readonly pDeny: number;
  readonly thresholds: AutoGateThresholds;
  readonly alwaysPrompt: boolean;
}): AutoGateVerdict {
  if (input.alwaysPrompt) {
    return { kind: "prompt", pDeny: input.pDeny, reason: "always-prompt" };
  }
  if (input.pDeny <= input.thresholds.allowBelow) {
    return { kind: "allow", pDeny: input.pDeny };
  }
  if (input.pDeny >= input.thresholds.denyAbove) {
    return { kind: "deny", pDeny: input.pDeny };
  }
  return { kind: "prompt", pDeny: input.pDeny, reason: "uncertain-band" };
}
