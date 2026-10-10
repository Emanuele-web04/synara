// FILE: automationCompletionPolicy.ts
// Purpose: Single source for translating a stop clause to the saved completion policy shape.
// Layer: Shared runtime utility (web composer + server agent gateway)
// Exports: stop-clause builders and extractors.
// Depends on: automation contracts shared with the native API.
//
// Completion policies are deliberately independent of AutomationMode: a stop clause
// describes when an automation retires, while the mode describes where its runs
// execute. Every mode supports "ai-evaluated".

import {
  DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
  type AutomationCompletionPolicy,
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
