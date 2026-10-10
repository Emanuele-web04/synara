import { DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES } from "@synara/contracts";

export type AutomationFailurePolicyValue = string;

export const AUTOMATION_FAILURE_POLICY_NEVER: AutomationFailurePolicyValue = "never";

export const DEFAULT_AUTOMATION_FAILURE_POLICY_VALUE: AutomationFailurePolicyValue = String(
  DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES,
);

const FAILURE_POLICY_PRESET_THRESHOLDS: readonly number[] = [1, 3, 5];

function failurePolicyLabel(value: AutomationFailurePolicyValue): string {
  if (value === AUTOMATION_FAILURE_POLICY_NEVER) return "Keep running";
  return value === "1" ? "Stop after 1 failure" : `Stop after ${value} failures`;
}

export function automationFailurePolicyValue(
  stopAfterConsecutiveFailures: number | null | undefined,
): AutomationFailurePolicyValue {
  // the contract decodes an absent field to the default threshold; only explicit null means never stop
  if (stopAfterConsecutiveFailures === undefined) {
    return DEFAULT_AUTOMATION_FAILURE_POLICY_VALUE;
  }
  return stopAfterConsecutiveFailures === null
    ? AUTOMATION_FAILURE_POLICY_NEVER
    : String(stopAfterConsecutiveFailures);
}

export function stopAfterConsecutiveFailuresFromPolicyValue(
  value: AutomationFailurePolicyValue,
): number | null {
  if (value === AUTOMATION_FAILURE_POLICY_NEVER) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES;
}

// a non-preset stored threshold (e.g. set via the agent gateway) is prepended so the current value always renders as itself
export function automationFailurePolicyOptions(
  currentValue: AutomationFailurePolicyValue,
): readonly { readonly value: AutomationFailurePolicyValue; readonly label: string }[] {
  const presets = [
    ...FAILURE_POLICY_PRESET_THRESHOLDS.map((threshold) => {
      const value = String(threshold);
      return { value, label: failurePolicyLabel(value) };
    }),
    {
      value: AUTOMATION_FAILURE_POLICY_NEVER,
      label: failurePolicyLabel(AUTOMATION_FAILURE_POLICY_NEVER),
    },
  ];
  return presets.some((preset) => preset.value === currentValue)
    ? presets
    : [{ value: currentValue, label: failurePolicyLabel(currentValue) }, ...presets];
}
