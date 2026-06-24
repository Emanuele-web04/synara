// FILE: automationDraft.ts
// Purpose: Builds editable automation drafts and safety warnings for chat-triggered creation.
// Layer: Web lib
// Exports: AutomationCreationDraft plus pure warning/skill helpers.
// Depends on: automation contracts shared with the native API.

import { DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS } from "@t3tools/contracts";
import type {
  AutomationMode,
  AutomationSchedule,
  AutomationWorktreeMode,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

import type { ChatAutomationExecutionScope } from "./automationIntent";

export type AutomationCreationDraftSource = "slash" | "mention" | "dialog" | "generated";

export type AutomationDraftWarningId =
  | "attachments-not-persisted"
  | "fast-recurring-interval"
  | "full-access"
  | "local-checkout"
  | "missing-schedule"
  | "generated-low-confidence"
  | "skill-reference"
  | "worktree-cleanup";

export interface AutomationDraftWarning {
  readonly id: AutomationDraftWarningId;
  readonly title: string;
  readonly detail: string;
  readonly requiresAcknowledgement: boolean;
}

export type AutomationAcknowledgedRiskId = "full-access" | "local-checkout" | "fast-interval";

export interface AutomationCreationDraft {
  readonly source: AutomationCreationDraftSource;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: AutomationSchedule;
  readonly mode: AutomationMode;
  readonly targetThreadId: ThreadId | null;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly worktreeMode: AutomationWorktreeMode;
  readonly maxIterations: number | null;
  readonly stopOnError: boolean;
  readonly warnings: readonly AutomationDraftWarning[];
}

export function containsAutomationSkillReference(prompt: string): boolean {
  return /(^|\s)\$[a-z0-9][a-z0-9_-]*(?=\s|$|[,.!?;:])/i.test(prompt);
}

export function buildAutomationDraftWarnings(input: {
  readonly schedule: AutomationSchedule;
  readonly mode: AutomationMode;
  readonly runtimeMode: RuntimeMode;
  readonly worktreeMode: AutomationWorktreeMode;
  readonly hasEphemeralContext: boolean;
  readonly generatedConfidence: number | null;
  readonly generatedNeedsConfirmation: boolean;
  readonly prompt: string;
}): readonly AutomationDraftWarning[] {
  const warnings: AutomationDraftWarning[] = [];
  if (input.hasEphemeralContext) {
    warnings.push({
      id: "attachments-not-persisted",
      title: "Composer context is not persisted",
      detail:
        "Attachments, provider mentions, pasted context, and terminal snippets will not be replayed on scheduled runs.",
      requiresAcknowledgement: true,
    });
  }
  if (input.schedule.type === "manual") {
    warnings.push({
      id: "missing-schedule",
      title: "Schedule needs review",
      detail: "Choose when this automation should run before creating it.",
      requiresAcknowledgement: false,
    });
  }
  if (input.schedule.type === "interval" && input.schedule.everySeconds < 60) {
    warnings.push({
      id: "fast-recurring-interval",
      title: "Fast recurring loop",
      detail: "Intervals under one minute can create noisy unattended runs.",
      requiresAcknowledgement: true,
    });
  }
  if (input.runtimeMode === "full-access") {
    warnings.push({
      id: "full-access",
      title: "Full access",
      detail: "Scheduled full-access runs can make changes without per-step approval.",
      requiresAcknowledgement: true,
    });
  }
  if (
    input.worktreeMode === "local" ||
    (input.mode === "standalone" && input.worktreeMode === "auto")
  ) {
    warnings.push({
      id: "local-checkout",
      title:
        input.worktreeMode === "auto" ? "Auto fallback may use local checkout" : "Local checkout",
      detail:
        input.worktreeMode === "auto"
          ? "If Synara cannot create a worktree, runs may fall back to editing the active project checkout."
          : "Runs may edit files in the active project checkout.",
      requiresAcknowledgement: true,
    });
  }
  if (
    input.mode === "standalone" &&
    (input.worktreeMode === "worktree" || input.worktreeMode === "auto")
  ) {
    warnings.push({
      id: "worktree-cleanup",
      title: "Worktree cleanup",
      detail: "Generated worktrees or branches are kept after archiving until you remove them.",
      requiresAcknowledgement: false,
    });
  }
  if (
    input.generatedNeedsConfirmation ||
    (input.generatedConfidence !== null && input.generatedConfidence < 0.75)
  ) {
    warnings.push({
      id: "generated-low-confidence",
      title: "Review generated fields",
      detail: "Synara was not fully confident about the parsed automation fields.",
      requiresAcknowledgement: false,
    });
  }
  if (containsAutomationSkillReference(input.prompt)) {
    warnings.push({
      id: "skill-reference",
      title: "Skill reference kept in prompt",
      detail:
        "Skill tokens stay as prompt text unless the selected provider can resolve them at run time.",
      requiresAcknowledgement: false,
    });
  }
  return warnings;
}

// Computes the approval an existing automation still needs before it can run, matching the
// server gate exactly. `warnings` are the run-blocking risks not yet acknowledged and drive
// the approval banner (empty means no approval is needed). `acknowledgedRisks` is the full
// set to persist when approving, merged with what is already acknowledged.
//
// Only full-access runtime and an explicit local checkout (worktreeMode "local") block a
// run. worktreeMode "auto" is excluded on purpose: the server needs local-checkout for auto
// only when it cannot create a worktree at runtime (a conditional fallback), so a normal
// auto run must not be blocked. fast-interval never blocks a run, but it is still persisted
// on approve so automation.update (which revalidates a sub-minute schedule) accepts the save.
export function automationApprovalGaps(input: {
  readonly schedule: AutomationSchedule;
  readonly mode: AutomationMode;
  readonly runtimeMode: RuntimeMode;
  readonly worktreeMode: AutomationWorktreeMode;
  readonly prompt: string;
  readonly acknowledgedRisks: readonly AutomationAcknowledgedRiskId[];
}): {
  readonly warnings: readonly AutomationDraftWarning[];
  readonly acknowledgedRisks: readonly AutomationAcknowledgedRiskId[];
} {
  const acknowledged = new Set(input.acknowledgedRisks);
  // Definite run blockers the server enforces up front (riskAcknowledgementError): full
  // access runtime and an explicit local checkout. These drive the banner and the Run-now
  // disable. "auto" is not a definite blocker, so a normal auto run is never blocked here.
  // Narrowed to the two ids that are both run blockers and valid warning ids, so the set can
  // seed the display warning ids below.
  const blocking = new Set<"full-access" | "local-checkout">();
  if (input.runtimeMode === "full-access" && !acknowledged.has("full-access")) {
    blocking.add("full-access");
  }
  if (
    input.worktreeMode === "local" &&
    // Heartbeat runs reuse the target thread and never resolve a local/worktree environment,
    // so local-checkout consent cannot block them; only standalone runs are gated at dispatch.
    input.mode === "standalone" &&
    !acknowledged.has("local-checkout")
  ) {
    blocking.add("local-checkout");
  }
  if (blocking.size === 0) {
    // Nothing blocks the run, so no approval is surfaced and nothing new is persisted.
    return { warnings: [], acknowledgedRisks: input.acknowledgedRisks };
  }
  // Display the blocking risks, plus the fast-recurring-loop risk when a sub-minute schedule
  // means approving will also acknowledge it — so the user sees everything they consent to,
  // not just the run blockers.
  const displayIds = new Set<AutomationDraftWarningId>(blocking);
  if (
    input.schedule.type === "interval" &&
    input.schedule.everySeconds < 60 &&
    !acknowledged.has("fast-interval")
  ) {
    displayIds.add("fast-recurring-interval");
  }
  const warnings = buildAutomationDraftWarnings({
    schedule: input.schedule,
    mode: input.mode,
    runtimeMode: input.runtimeMode,
    worktreeMode: input.worktreeMode,
    hasEphemeralContext: false,
    generatedConfidence: null,
    generatedNeedsConfirmation: false,
    prompt: input.prompt,
  }).filter((warning) => displayIds.has(warning.id));
  // Persist every risk the config requires so the automation is fully runnable: local
  // checkout is included for "auto" too, so a runtime worktree-creation fallback is covered
  // once approved, plus fast-interval for a sub-minute schedule (automation.update would
  // otherwise reject it).
  const required = new Set<AutomationAcknowledgedRiskId>(input.acknowledgedRisks);
  if (input.runtimeMode === "full-access") {
    required.add("full-access");
  }
  if (input.worktreeMode === "local" || input.worktreeMode === "auto") {
    required.add("local-checkout");
  }
  if (input.schedule.type === "interval" && input.schedule.everySeconds < 60) {
    required.add("fast-interval");
  }
  return { warnings, acknowledgedRisks: Array.from(required) };
}

export function acknowledgedRiskIdsForDraft(
  warnings: readonly AutomationDraftWarning[],
  acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId>,
) {
  const risks: AutomationAcknowledgedRiskId[] = [];
  for (const warning of warnings) {
    if (!warning.requiresAcknowledgement || !acknowledgedWarningIds.has(warning.id)) {
      continue;
    }
    if (warning.id === "full-access" || warning.id === "local-checkout") {
      risks.push(warning.id);
    } else if (warning.id === "fast-recurring-interval") {
      risks.push("fast-interval");
    }
  }
  return risks;
}

export function warningIdsForAcknowledgedRisks(
  risks: readonly AutomationAcknowledgedRiskId[],
): ReadonlySet<AutomationDraftWarningId> {
  const ids = new Set<AutomationDraftWarningId>();
  for (const risk of risks) {
    ids.add(risk === "fast-interval" ? "fast-recurring-interval" : risk);
  }
  return ids;
}

export function hasBlockingAutomationDraftWarnings(
  warnings: readonly AutomationDraftWarning[],
  acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId>,
): boolean {
  return warnings.some(
    (warning) =>
      warning.id === "missing-schedule" ||
      (warning.requiresAcknowledgement && !acknowledgedWarningIds.has(warning.id)),
  );
}

// Thread-bound chat creation can accept bounded fast loops without reopening the form.
export function acknowledgedWarningIdsForAutomaticChatAutomation(input: {
  readonly warnings: readonly AutomationDraftWarning[];
  readonly maxIterations: number | null;
  readonly executionScope: ChatAutomationExecutionScope;
}): ReadonlySet<AutomationDraftWarningId> {
  const ids = new Set<AutomationDraftWarningId>();
  if (input.executionScope !== "thread") {
    return ids;
  }
  for (const warning of input.warnings) {
    if (
      warning.id === "fast-recurring-interval" &&
      input.maxIterations !== null &&
      input.maxIterations <= DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS
    ) {
      ids.add(warning.id);
    }
  }
  return ids;
}
