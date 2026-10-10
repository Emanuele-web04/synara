import type {
  AssistantDeliveryMode,
  ProviderKind,
  ProviderStartOptions,
  ThreadId,
} from "@synara/contracts";

import type { ProviderInstanceOption } from "../appSettings";
import { createDraftThread, type DraftThreadInput } from "./draftThreadCreate";
import {
  dispatchKanbanDraftThread,
  dispatchKanbanDraftThreadAsGoal,
  type KanbanDraftDispatchResult,
} from "./kanbanDispatch";

export type KanbanDraftTaskInput = Omit<DraftThreadInput, "workingDirectory">;

/**
 * Registers a new mapping-less draft thread and seeds its composer content. The
 * project's regular composer draft is untouched, so any number of tasks can be
 * created back to back.
 */
export function createKanbanDraftTask(input: KanbanDraftTaskInput): ThreadId {
  return createDraftThread(input);
}

/**
 * Creates the draft, then immediately promotes + dispatches it so the task skips
 * the Draft column and lands in In Progress — the "send now" path for the new-task
 * dialog. Reuses {@link dispatchKanbanDraftThread} so a sent task behaves exactly
 * like dragging a Draft card onto In Progress. Pass `sendAsGoal` to route through
 * {@link dispatchKanbanDraftThreadAsGoal} instead, so the task starts with its
 * prompt saved as the thread goal (the dialog's "send as goal" toggle, off by
 * default).
 */
export async function createAndSendKanbanTask(
  input: KanbanDraftTaskInput & {
    defaultProvider: ProviderKind;
    assistantDeliveryMode: AssistantDeliveryMode;
    providerOptions?: ProviderStartOptions | undefined;
    sendAsGoal?: boolean | undefined;
    providerInstances?: ReadonlyArray<Pick<ProviderInstanceOption, "instanceId" | "provider">>;
  },
): Promise<{ threadId: ThreadId; result: KanbanDraftDispatchResult }> {
  const threadId = createKanbanDraftTask(input);
  const dispatch =
    input.sendAsGoal === true ? dispatchKanbanDraftThreadAsGoal : dispatchKanbanDraftThread;
  const result = await dispatch({
    threadId,
    projectId: input.projectId,
    thread: null,
    defaultProvider: input.defaultProvider,
    assistantDeliveryMode: input.assistantDeliveryMode,
    providerOptions: input.providerOptions,
    providerInstances: input.providerInstances,
  });
  return { threadId, result };
}
