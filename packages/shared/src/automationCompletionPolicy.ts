// completion policies are independent of AutomationMode — a stop clause is when it retires, the mode is where runs execute

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
