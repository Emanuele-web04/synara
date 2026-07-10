// FILE: automationCompletionPolicy.ts
// Purpose: Centralizes UI rules for heartbeat stop clauses and their saved policy shape.
// Layer: Web lib
// Exports: stop-policy builders, extractors, and mode/review helpers.
// Depends on: automation contracts shared with the native API.

import {
  DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
  type AutomationCompletionPolicy,
  type AutomationMode,
} from "@synara/contracts";

export function completionPolicyFromStopWhen(stopWhen: string): AutomationCompletionPolicy {
  const normalized = stopWhen.trim();
  return normalized
    ? {
        type: "ai-evaluated",
        stopWhen: normalized,
        confidenceThreshold: DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
      }
    : { type: "none" };
}

export function stopWhenFromCompletionPolicy(policy: AutomationCompletionPolicy): string {
  return policy.type === "ai-evaluated" ? policy.stopWhen : "";
}

export function modeForCompletionPolicy(
  mode: AutomationMode,
  policy: AutomationCompletionPolicy,
): AutomationMode {
  return policy.type === "ai-evaluated" ? "heartbeat" : mode;
}

export function requiresCompletionPolicyReview(
  mode: AutomationMode,
  policy: AutomationCompletionPolicy,
): boolean {
  return policy.type === "ai-evaluated" && mode !== "heartbeat";
}
