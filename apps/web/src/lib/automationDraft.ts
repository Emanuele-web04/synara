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

function warningIdsRequiringAcknowledgement(
  warnings: readonly AutomationDraftWarning[],
): ReadonlySet<AutomationDraftWarningId> {
  return new Set(
    warnings.filter((warning) => warning.requiresAcknowledgement).map((warning) => warning.id),
  );
}

// Computes the approval an existing automation still needs before it can run.
// `warnings` are the visible risks that the approval will persist, and `acknowledgedRisks`
// is the full risk set to save: every risk the config requires, merged with existing
// acknowledgements. Sub-minute schedules may also need a capped maxIterations patch so the
// acknowledgement-only update passes the server's active-schedule validation.
export function automationApprovalGaps(input: {
  readonly schedule: AutomationSchedule;
  readonly mode: AutomationMode;
  readonly runtimeMode: RuntimeMode;
  readonly worktreeMode: AutomationWorktreeMode;
  readonly prompt: string;
  readonly acknowledgedRisks: readonly AutomationAcknowledgedRiskId[];
  readonly enabled?: boolean;
  readonly maxIterations?: number | null;
}): {
  readonly warnings: readonly AutomationDraftWarning[];
  readonly acknowledgedRisks: readonly AutomationAcknowledgedRiskId[];
  readonly maxIterations?: number;
} {
  const allWarnings = buildAutomationDraftWarnings({
    schedule: input.schedule,
    mode: input.mode,
    runtimeMode: input.runtimeMode,
    worktreeMode: input.worktreeMode,
    hasEphemeralContext: false,
    generatedConfidence: null,
    generatedNeedsConfirmation: false,
    prompt: input.prompt,
  });
  const requiredWarningIds = warningIdsRequiringAcknowledgement(allWarnings);
  const acknowledgedWarningIds = warningIdsForAcknowledgedRisks(input.acknowledgedRisks);
  const warnings = allWarnings.filter(
    (warning) =>
      warning.requiresAcknowledgement &&
      requiredWarningIds.has(warning.id) &&
      !acknowledgedWarningIds.has(warning.id),
  );
  const acknowledgedRisks = Array.from(
    new Set([
      ...input.acknowledgedRisks,
      ...acknowledgedRiskIdsForDraft(allWarnings, requiredWarningIds),
    ]),
  );
  const maxIterations =
    input.enabled === true &&
    input.schedule.type === "interval" &&
    input.schedule.everySeconds < 60 &&
    (input.maxIterations === null ||
      (input.maxIterations ?? DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS) >
        DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS)
      ? DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS
      : undefined;
  return { warnings, acknowledgedRisks, maxIterations };
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
