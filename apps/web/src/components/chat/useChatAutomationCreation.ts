import {
  EventId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type AutomationSchedule,
  type ModelSelection,
  type ProviderStartOptions,
} from "@synara/contracts";
import { automationRequiresTargetThread } from "@synara/shared/automationMode";
import {
  GENERIC_CHAT_THREAD_TITLE,
  buildPromptThreadTitleFallback,
} from "@synara/shared/chatThreads";
import { deriveAssociatedWorktreeMetadata } from "@synara/shared/threadWorkspace";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { promoteThreadCreate } from "~/lib/threadCreatePromotion";
import { newCommandId, randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { dispatchThreadNotes } from "~/pinnedMessages";
import {
  mergeProjectInstructionsIntoThreadNotes,
  useProjectInstructionsStore,
} from "~/projectInstructionsStore";
import {
  acknowledgedRiskIdsForDraft,
  hasBlockingAutomationDraftWarnings,
  type AutomationDraftWarning,
  type AutomationDraftWarningId,
} from "../../lib/automationDraft";
import {
  automationQueryKey,
  createInputFromForm,
  formatCadence,
  isFormSubmittable,
  type AutomationFormState,
} from "../../routes/-automations.shared";
import type { Project } from "../../types";
import { type Thread } from "../../types";
import { useChatAutomationSetup } from "./useChatAutomationSetup";
import { toastManager } from "../ui/toast";
function automationScheduleActivityPayload(schedule: AutomationSchedule) {
  switch (schedule.type) {
    case "manual":
      return { type: "manual" } as const;
    case "once":
      return { type: "once", runAt: schedule.runAt } as const;
    case "interval":
      return { type: "interval", everySeconds: schedule.everySeconds } as const;
    case "daily":
      return schedule.timezone
        ? { type: "daily", timeOfDay: schedule.timeOfDay, timezone: schedule.timezone }
        : { type: "daily", timeOfDay: schedule.timeOfDay };
    case "weekdays":
      return schedule.timezone
        ? { type: "weekdays", timeOfDay: schedule.timeOfDay, timezone: schedule.timezone }
        : { type: "weekdays", timeOfDay: schedule.timeOfDay };
    case "weekly":
      return schedule.timezone
        ? {
            type: "weekly",
            dayOfWeek: schedule.dayOfWeek,
            timeOfDay: schedule.timeOfDay,
            timezone: schedule.timezone,
          }
        : {
            type: "weekly",
            dayOfWeek: schedule.dayOfWeek,
            timeOfDay: schedule.timeOfDay,
          };
    case "cron":
      return {
        type: "cron",
        expression: schedule.expression,
        timezone: schedule.timezone,
      } as const;
  }
}
interface ChatAutomationCreationInput {
  threadId: ThreadId;
  activeProject: Project | undefined;
  automationDraftSubmittingRef: ReturnType<
    typeof useChatAutomationSetup
  >["automationDraftSubmittingRef"];
  isServerThread: boolean;
  activeThread: Thread | undefined;
  providerOptionsForDispatch: ProviderStartOptions | undefined;
  setIsAutomationDraftSubmitting: ReturnType<
    typeof useChatAutomationSetup
  >["setIsAutomationDraftSubmitting"];
  queryClient: QueryClient;
  clearComposerInput: (threadId: ThreadId) => void;
  resetAutomationDraftState: ReturnType<typeof useChatAutomationSetup>["resetAutomationDraftState"];
  activeThreadAssociatedWorktree: ReturnType<typeof deriveAssociatedWorktreeMetadata>;
  threadNotes: string;
  selectedModelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  automationDraftForm: ReturnType<typeof useChatAutomationSetup>["automationDraftForm"];
  automationDraftWarnings: ReturnType<typeof useChatAutomationSetup>["automationDraftWarnings"];
  acknowledgedAutomationWarnings: ReturnType<
    typeof useChatAutomationSetup
  >["acknowledgedAutomationWarnings"];
}

export function useChatAutomationCreation({
  threadId,
  activeProject,
  automationDraftSubmittingRef,
  isServerThread,
  activeThread,
  providerOptionsForDispatch,
  setIsAutomationDraftSubmitting,
  queryClient,
  clearComposerInput,
  resetAutomationDraftState,
  activeThreadAssociatedWorktree,
  threadNotes,
  selectedModelSelection,
  runtimeMode,
  interactionMode,
  automationDraftForm,
  automationDraftWarnings,
  acknowledgedAutomationWarnings,
}: ChatAutomationCreationInput) {
  const createAutomationFromForm = useCallback(
    async (input: {
      readonly form: AutomationFormState;
      readonly warnings: readonly AutomationDraftWarning[];
      readonly acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId>;
      readonly providerOptions?: ProviderStartOptions;
      readonly activityThreadId?: ThreadId | null;
    }): Promise<boolean> => {
      const api = readNativeApi();
      if (!api || !activeProject) {
        return false;
      }
      if (automationDraftSubmittingRef.current) {
        return false;
      }
      if (!isFormSubmittable(input.form)) {
        return false;
      }
      if (hasBlockingAutomationDraftWarnings(input.warnings, input.acknowledgedWarningIds)) {
        return false;
      }
      const acknowledgedRisks = acknowledgedRiskIdsForDraft(
        input.warnings,
        input.acknowledgedWarningIds,
      );
      const activityThreadId =
        input.activityThreadId ?? (isServerThread ? (activeThread?.id ?? null) : null);
      const createdAt = new Date().toISOString();
      const automationInput = createInputFromForm(
        input.form,
        input.providerOptions ?? providerOptionsForDispatch,
        acknowledgedRisks,
        activityThreadId,
      );
      automationDraftSubmittingRef.current = true;
      setIsAutomationDraftSubmitting(true);
      return await (async () => {
        const definition = await api.automation.create(automationInput);
        if (activityThreadId) {
          void (async () => {
            try {
              await api.orchestration.dispatchCommand({
                type: "thread.activity.append",
                commandId: newCommandId(),
                threadId: activityThreadId,
                activity: {
                  id: EventId.makeUnsafe(randomUUID()),
                  tone: "info",
                  kind: "automation.created",
                  summary: `Created automation: ${definition.name} - ${formatCadence(definition.schedule)}`,
                  payload: {
                    source: "chat-composer",
                    automationId: definition.id,
                    automationName: definition.name,
                    mode: definition.mode,
                    cadenceLabel: formatCadence(definition.schedule),
                    schedule: automationScheduleActivityPayload(definition.schedule),
                  },
                  turnId: null,
                  createdAt,
                },
                createdAt,
              });
            } catch {
              toastManager.add({
                type: "warning",
                title: "Thread note not added",
                description:
                  "The automation was created, but Synara could not add the activity note.",
              });
            }
          })();
        }
        void queryClient.invalidateQueries({ queryKey: automationQueryKey });
        clearComposerInput(activeThread?.id ?? threadId);
        resetAutomationDraftState();
        toastManager.add({
          type: "success",
          title: "Automation created",
          description: `${definition.name} - ${formatCadence(definition.schedule)}`,
        });
        return true;
      })()
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not create automation",
            description:
              error instanceof Error ? error.message : "Synara could not save the automation.",
          });
          return false;
        })
        .finally(() => {
          automationDraftSubmittingRef.current = false;
          setIsAutomationDraftSubmitting(false);
        });
    },
    [
      activeProject,
      activeThread,
      automationDraftSubmittingRef,
      clearComposerInput,
      isServerThread,
      providerOptionsForDispatch,
      queryClient,
      resetAutomationDraftState,
      setIsAutomationDraftSubmitting,
      threadId,
    ],
  );

  const ensureAutomationTargetThread = useCallback(
    async (input: {
      readonly titleSeed: string;
      readonly threadModelSelection: ModelSelection;
      readonly threadRuntimeMode: RuntimeMode;
      readonly threadInteractionMode: ProviderInteractionMode;
    }): Promise<ThreadId | null> => {
      const api = readNativeApi();
      if (!api || !activeProject || !activeThread) {
        toastManager.add({
          type: "warning",
          title: "Chat required",
          description: "Open a chat before creating a chat-bound automation.",
        });
        return null;
      }
      if (isServerThread) {
        return activeThread.id;
      }

      const title = buildPromptThreadTitleFallback(input.titleSeed || GENERIC_CHAT_THREAD_TITLE);
      // Nested function so the `try` body holds no value blocks — see the comment on
      // `deleteEmptyTerminalThread` above for why React Compiler requires this shape.
      const promoteDraftForAutomation = async (): Promise<ThreadId | null> => {
        const result = await promoteThreadCreate(
          {
            type: "thread.create",
            commandId: newCommandId(),
            threadId: activeThread.id,
            projectId: activeProject.id,
            title,
            modelSelection: input.threadModelSelection,
            runtimeMode: input.threadRuntimeMode,
            interactionMode: input.threadInteractionMode,
            envMode: activeThread.envMode ?? (activeThread.worktreePath ? "worktree" : "local"),
            branch: activeThread.branch ?? null,
            worktreePath: activeThread.worktreePath ?? null,
            workingDirectory: activeThread.workingDirectory ?? null,
            associatedWorktreePath: activeThreadAssociatedWorktree.associatedWorktreePath,
            associatedWorktreeBranch: activeThreadAssociatedWorktree.associatedWorktreeBranch,
            associatedWorktreeRef: activeThreadAssociatedWorktree.associatedWorktreeRef,
            lastKnownPr: activeThread.lastKnownPr ?? null,
            createdAt: activeThread.createdAt,
          },
          api,
          { force: true },
        );
        if (result === "unavailable") {
          toastManager.add({
            type: "error",
            title: "Could not create chat",
            description: "Synara could not promote this draft before saving the automation.",
          });
          return null;
        }

        const inheritedProjectInstructions =
          useProjectInstructionsStore.getState().instructionsByProjectId[activeProject.id] ?? "";
        const inheritedThreadNotes = mergeProjectInstructionsIntoThreadNotes({
          threadNotes,
          projectInstructions: inheritedProjectInstructions,
        });
        if (inheritedThreadNotes !== threadNotes && inheritedThreadNotes.trim().length > 0) {
          void dispatchThreadNotes(activeThread.id, inheritedThreadNotes).catch(() => undefined);
        }

        return activeThread.id;
      };

      try {
        return await promoteDraftForAutomation();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not create chat",
          description:
            error instanceof Error
              ? error.message
              : "Synara could not promote this draft before saving the automation.",
        });
        return null;
      }
    },
    [activeProject, activeThread, activeThreadAssociatedWorktree, isServerThread, threadNotes],
  );

  const prepareAutomationFormForCreate = useCallback(
    async (
      form: AutomationFormState,
    ): Promise<{
      readonly form: AutomationFormState;
      readonly activityThreadId: ThreadId | null;
    } | null> => {
      const activityThreadId = isServerThread ? (activeThread?.id ?? null) : null;
      if (!automationRequiresTargetThread(form.mode) || !activeThread) {
        return { form, activityThreadId };
      }
      if (isServerThread || form.targetThreadId !== activeThread.id) {
        return { form, activityThreadId };
      }

      // Draft review can keep the local draft ID in the form; promote it only when
      // the automation is actually submitted so cancelling review leaves no empty thread.
      const targetThreadId = await ensureAutomationTargetThread({
        titleSeed: form.prompt || form.name,
        threadModelSelection: selectedModelSelection,
        threadRuntimeMode: runtimeMode,
        threadInteractionMode: interactionMode,
      });
      if (!targetThreadId) {
        return null;
      }
      return {
        form: { ...form, targetThreadId },
        activityThreadId: targetThreadId,
      };
    },
    [
      activeThread,
      ensureAutomationTargetThread,
      interactionMode,
      isServerThread,
      runtimeMode,
      selectedModelSelection,
    ],
  );

  const submitAutomationDraft = useCallback(async () => {
    if (!automationDraftForm) {
      return;
    }
    if (
      !isFormSubmittable(automationDraftForm) ||
      hasBlockingAutomationDraftWarnings(automationDraftWarnings, acknowledgedAutomationWarnings)
    ) {
      return;
    }
    const preparedCreate = await prepareAutomationFormForCreate(automationDraftForm);
    if (!preparedCreate) {
      return;
    }
    await createAutomationFromForm({
      form: preparedCreate.form,
      warnings: automationDraftWarnings,
      acknowledgedWarningIds: acknowledgedAutomationWarnings,
      activityThreadId: preparedCreate.activityThreadId,
    });
  }, [
    acknowledgedAutomationWarnings,
    automationDraftForm,
    automationDraftWarnings,
    createAutomationFromForm,
    prepareAutomationFormForCreate,
  ]);
  return { createAutomationFromForm, prepareAutomationFormForCreate, submitAutomationDraft };
}
