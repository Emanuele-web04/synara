// FILE: runEnvelope.ts
// Purpose: Builds the single canonical synthetic message sent to automation runs.

import type { AutomationDefinition, AutomationRun } from "@synara/contracts";

export const AUTOMATION_MEMORY_INJECTION_MAX_BYTES = 8 * 1_024;
export const AUTOMATION_MEMORY_TRUNCATION_MARKER = "[... older automation memory truncated ...]\n";

export function automationMemoryForEnvelope(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength <= AUTOMATION_MEMORY_INJECTION_MAX_BYTES) {
    return content || "(empty)";
  }

  const marker = Buffer.from(AUTOMATION_MEMORY_TRUNCATION_MARKER, "utf8");
  const suffixBudget = AUTOMATION_MEMORY_INJECTION_MAX_BYTES - marker.byteLength;
  let start = Math.max(0, bytes.byteLength - suffixBudget);
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return `${AUTOMATION_MEMORY_TRUNCATION_MARKER}${bytes.subarray(start).toString("utf8")}`;
}

function iterationLabel(definition: AutomationDefinition, run: AutomationRun): string {
  const iteration = run.permissionSnapshot.iterationNumber ?? definition.iterationCount + 1;
  return `${iteration}/${definition.maxIterations ?? "∞"}`;
}

function reportingInstructions(mode: AutomationDefinition["mode"]): string {
  if (mode === "heartbeat") {
    return [
      "Before finishing, call synara_report_automation_result.",
      'Use decision "silent" when nothing needs the user\'s attention; otherwise use "notify".',
      "You may call synara_cancel_automation on this automation when monitoring is no longer needed.",
    ].join(" ");
  }
  return [
    "Before finishing, call synara_report_automation_result with a concise title and summary.",
    'Use decision "notify" unless the successful run genuinely requires no user attention.',
  ].join(" ");
}

export function buildAutomationRunEnvelope(input: {
  readonly definition: AutomationDefinition;
  readonly run: AutomationRun;
  readonly memoryContent: string;
  readonly lastRunAt: string | null;
}): string {
  const { definition, run } = input;
  return [
    `Automation: ${definition.name}`,
    `Automation ID: ${definition.id}`,
    `Run: ${run.trigger.type}, scheduled for ${run.scheduledFor} (last run: ${
      input.lastRunAt ?? "never"
    }, iteration ${iterationLabel(definition, run)})`,
    'Memory (persistent across runs — replace it via synara_update_automation_memory {"memory": "..."} before finishing):',
    automationMemoryForEnvelope(input.memoryContent),
    "",
    reportingInstructions(definition.mode),
    "",
    "---",
    "",
    definition.prompt,
  ].join("\n");
}
