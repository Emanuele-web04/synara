// FILE: composerAutomation.ts
// Purpose: Turns composer text into automation decisions and drafts while keeping ChatView thin.
// Layer: Web composer orchestration helper
// Exports: composer automation resolver plus draft builder for ChatView.
// Depends on: automationIntent parsing and automation form helpers.

import { DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS } from "@t3tools/contracts";
import type {
  AutomationMode,
  ModelSelection,
  ProjectId,
  ServerGenerateAutomationIntentInput,
  ServerGenerateAutomationIntentResult,
  ThreadId,
} from "@t3tools/contracts";

import {
  applyScheduleToForm,
  formFromDefinition,
  isFormSubmittable,
  type AutomationFormState,
} from "./automationForm";
import { stopWhenFromCompletionPolicy } from "./automationCompletionPolicy";
import {
  acknowledgedWarningIdsForAutomaticChatAutomation,
  buildAutomationDraftWarnings,
  hasBlockingAutomationDraftWarnings,
  type AutomationDraftWarning,
  type AutomationDraftWarningId,
} from "./automationDraft";
import {
  detectChatAutomationExecutionScope,
  extractChatAutomationInvocation,
  extractPlainChatAutomationCreationInvocation,
  parseChatAutomationInvocation,
  parsePlainChatAutomationInvocation,
  resolveChatAutomationIntent,
  shouldGenerateAutomationIntent,
  type ChatAutomationIntent,
  type ResolvedChatAutomationIntent,
} from "./automationIntent";

type GenerateComposerAutomationIntent = (
  input: ServerGenerateAutomationIntentInput,
) => Promise<ServerGenerateAutomationIntentResult>;

const DEFAULT_GENERATE_INTENT_TIMEOUT_MS = 1_500;

export type ComposerAutomationRequestDecision =
  | { readonly type: "normal-chat" }
  | {
      readonly type: "missing-schedule";
      readonly reason: string | null;
    }
  | {
      readonly type: "automation";
      readonly automationMessage: string;
      readonly resolution: ResolvedChatAutomationIntent;
    };

export interface ComposerAutomationDraftDecision {
  readonly form: AutomationFormState;
  readonly warnings: readonly AutomationDraftWarning[];
  readonly warningContext: {
    readonly hasEphemeralContext: boolean;
    readonly generatedConfidence: number | null;
    readonly generatedNeedsConfirmation: boolean;
  };
  readonly acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId>;
  readonly needsDraftReview: boolean;
}

// ─── ENTRY POINT ─────────────────────────────────────────────

async function generateIntentWithTimeout(input: {
  readonly generateIntent: GenerateComposerAutomationIntent;
  readonly request: ServerGenerateAutomationIntentInput;
  readonly timeoutMs: number;
}): Promise<ServerGenerateAutomationIntentResult | null> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      input.generateIntent(input.request).catch(() => null),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), Math.max(0, input.timeoutMs));
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

function isAutoSubmittableBoundedFastLoop(intent: ChatAutomationIntent | null): boolean {
  if (!intent || intent.executionScope !== "thread") {
    return false;
  }
  return (
    intent.schedule.type === "interval" &&
    intent.schedule.everySeconds < 60 &&
    intent.maxIterations !== null &&
    intent.maxIterations <= DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS
  );
}

// Resolves whether a composer submission should stay chat or become an automation.
export async function resolveComposerAutomationRequest(input: {
  readonly message: string;
  readonly cwd: string;
  readonly nowIso?: string;
  readonly generateIntent: GenerateComposerAutomationIntent;
  readonly generateIntentTimeoutMs?: number;
}): Promise<ComposerAutomationRequestDecision> {
  const trimmed = input.message.trim();
  if (!trimmed) {
    return { type: "normal-chat" };
  }

  const explicitAutomationInvocation = extractChatAutomationInvocation(trimmed);
  const nowIso = input.nowIso ?? new Date().toISOString();
  const plainCreationInvocation =
    explicitAutomationInvocation === null
      ? extractPlainChatAutomationCreationInvocation(trimmed)
      : null;
  const automaticAutomationIntent =
    explicitAutomationInvocation === null
      ? parsePlainChatAutomationInvocation(trimmed, { nowIso })
      : null;
  const automationInvocation =
    explicitAutomationInvocation ?? (automaticAutomationIntent ? trimmed : plainCreationInvocation);
  if (automationInvocation === null) {
    return { type: "normal-chat" };
  }

  const automationMessage = automationInvocation.trim();
  const deterministicAutomationIntent =
    automaticAutomationIntent ??
    parseChatAutomationInvocation(automationInvocation, {
      nowIso,
    });
  const automationExecutionScope =
    deterministicAutomationIntent?.executionScope ??
    detectChatAutomationExecutionScope(automationMessage);
  const automationDefaultMode: AutomationMode =
    automationExecutionScope === "thread" ? "heartbeat" : "standalone";
  const shouldGenerateIntent =
    !isAutoSubmittableBoundedFastLoop(deterministicAutomationIntent) &&
    shouldGenerateAutomationIntent({
      deterministicIntent: deterministicAutomationIntent,
      automationMessage,
    });
  const generatedAutomationIntent = shouldGenerateIntent
    ? await generateIntentWithTimeout({
        generateIntent: input.generateIntent,
        timeoutMs: input.generateIntentTimeoutMs ?? DEFAULT_GENERATE_INTENT_TIMEOUT_MS,
        request: {
          cwd: input.cwd,
          message: automationMessage,
          defaultMode: automationDefaultMode,
          nowIso,
        },
      })
    : null;
  const automationResolution = resolveChatAutomationIntent({
    deterministicIntent: deterministicAutomationIntent,
    generatedIntent: generatedAutomationIntent,
    defaultMode: automationDefaultMode,
    executionScope: automationExecutionScope,
  });
  if (!automationResolution) {
    return {
      type: "missing-schedule",
      reason: generatedAutomationIntent?.reason ?? null,
    };
  }

  return {
    type: "automation",
    automationMessage,
    resolution: automationResolution,
  };
}

// Builds the draft form and review state once ChatView has resolved any thread target.
export function buildComposerAutomationDraft(input: {
  readonly resolution: ResolvedChatAutomationIntent;
  readonly projectId: ProjectId;
  readonly projectModelSelection: ModelSelection;
  readonly selectedModelSelection: ModelSelection;
  readonly targetThreadId: ThreadId | null;
  readonly hasEphemeralContext: boolean;
}): ComposerAutomationDraftDecision {
  const { intent: automationIntent, mode: automationMode } = input.resolution;
  const automationStopWhen = stopWhenFromCompletionPolicy(automationIntent.completionPolicy);
  const baseForm = formFromDefinition(null, input.projectId, input.projectModelSelection);
  // Chat-created automations should not inherit live Full access; escalating scheduled
  // runs stays an explicit review step in the automation dialog.
  const nextForm = applyScheduleToForm(
    {
      ...baseForm,
      name: automationIntent.name,
      prompt: automationIntent.prompt,
      projectId: input.projectId,
      modelSelection: input.selectedModelSelection,
      runtimeMode: "approval-required",
      worktreeMode: automationIntent.executionScope === "worktree" ? "worktree" : "auto",
      mode: automationMode,
      targetThreadId:
        automationMode === "heartbeat" && input.targetThreadId ? input.targetThreadId : "",
      maxIterations:
        automationIntent.maxIterations === null ? "" : String(automationIntent.maxIterations),
      stopOnError: true,
      stopWhen: automationMode === "heartbeat" ? automationStopWhen : "",
    },
    automationIntent.schedule,
  );
  const warnings = buildAutomationDraftWarnings({
    schedule: automationIntent.schedule,
    mode: nextForm.mode,
    runtimeMode: nextForm.runtimeMode,
    worktreeMode: nextForm.worktreeMode,
    hasEphemeralContext: input.hasEphemeralContext,
    generatedConfidence: input.resolution.generatedConfidence,
    generatedNeedsConfirmation: input.resolution.generatedNeedsConfirmation,
    prompt: automationIntent.prompt,
  });
  const warningContext = {
    hasEphemeralContext: input.hasEphemeralContext,
    generatedConfidence: input.resolution.generatedConfidence,
    generatedNeedsConfirmation: input.resolution.generatedNeedsConfirmation,
  };
  const acknowledgedWarningIds = acknowledgedWarningIdsForAutomaticChatAutomation({
    warnings,
    maxIterations: automationIntent.maxIterations,
    executionScope: automationIntent.executionScope,
  });
  const needsDraftReview =
    input.resolution.requiresReview ||
    input.resolution.generatedNeedsConfirmation ||
    !isFormSubmittable(nextForm) ||
    hasBlockingAutomationDraftWarnings(warnings, acknowledgedWarningIds);

  return {
    form: nextForm,
    warnings,
    warningContext,
    acknowledgedWarningIds,
    needsDraftReview,
  };
}
