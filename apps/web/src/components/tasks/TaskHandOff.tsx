// FILE: TaskHandOff.tsx
// Purpose: The task card's "Hand it to an agent" controls: which agent and model, where it
//          runs, and Start. The agent gets the to-do's title and note, so there is no second
//          prompt to fill in. The rest — reusing an existing chat, access — sits behind "More
//          options". Model state rides on a scratch composer draft so the shared composer
//          pickers work unchanged; the start logic lives in useTaskDelegation.
// Layer: Tasks UI component
// Exports: TaskHandOff

import type { Todo, TodoUpdateInput } from "@synara/contracts";
import { applyClaudePromptEffortPrefix, isClaudeUltrathinkPrompt } from "@synara/shared/model";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useAppSettings } from "~/appSettings";
import {
  ScratchModelPickers,
  ScratchRuntimeControls,
} from "~/components/chat/ScratchAgentControls";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useScratchComposerDraft } from "~/hooks/useScratchComposerDraft";
import { useScratchModelCatalog } from "~/hooks/useScratchModelCatalog";
import { LoaderCircleIcon } from "~/lib/icons";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import { TaskActionButton, TaskCardLabel } from "./TaskCardPrimitives";
import { TaskDelegateChatPicker } from "./TaskDelegateChatPicker";
import { TaskDelegateTargetPicker } from "./TaskDelegateTargetPicker";
import { buildDelegationPrompt } from "./tasks.logic";
import { useTaskDelegateChat } from "./useTaskDelegateChat";
import { useTaskDelegateTarget } from "./useTaskDelegateTarget";
import { useTaskDelegation } from "./useTaskDelegation";

export function TaskHandOff({
  todo,
  onLinkChat,
}: {
  todo: Todo;
  /** Records the chat on the to-do; runs before anything is sent, and throwing aborts. */
  onLinkChat: (input: TodoUpdateInput) => Promise<unknown>;
}) {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const providerStatuses = useProviderStatusesForLocalConfig();
  const draft = useScratchComposerDraft({
    defaultProvider: settings.defaultProvider,
    initialPrompt: buildDelegationPrompt(todo),
  });
  const { scratchThreadId, setPrompt } = draft;
  const runIn = useTaskDelegateTarget(todo.projectId);
  const { target, targetProject } = runIn;
  const chat = useTaskDelegateChat(todo.id);
  const { existingChat } = chat;
  const catalog = useScratchModelCatalog({
    draft,
    providerStatuses,
    discoveryCwd: resolveProviderDiscoveryCwd({
      activeThreadWorktreePath: null,
      activeProjectCwd: target?.kind === "folder" ? target.path : (targetProject?.cwd ?? null),
      serverCwd: serverConfigQuery.data?.cwd ?? null,
    }),
  });
  // An existing chat picked there changes what Start does, so its row stays visible.
  const [showsMore, setShowsMore] = useState(false);

  // The prompt is the to-do's title and notes, and follows their edits. Picking Ultrathink
  // writes its keyword into the prompt; keep it when the to-do changes.
  const delegationPrompt = buildDelegationPrompt(todo);
  useEffect(() => {
    const current = useComposerDraftStore.getState().draftsByThreadId[scratchThreadId]?.prompt;
    const next =
      isClaudeUltrathinkPrompt(current) && !isClaudeUltrathinkPrompt(delegationPrompt)
        ? applyClaudePromptEffortPrefix(delegationPrompt, "ultrathink")
        : delegationPrompt;
    if (current !== next) setPrompt(next);
  }, [delegationPrompt, scratchThreadId, setPrompt]);

  const { isStarting, canStart, handleStart } = useTaskDelegation({
    todo,
    onLinkChat,
    onDelegated: undefined,
    draft,
    catalog,
    providerStatuses,
    target,
    existingChat,
  });

  return (
    <section
      aria-label="Hand it to an agent"
      className="flex flex-col gap-1.5"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void handleStart();
        }
      }}
    >
      <TaskCardLabel>Hand it to an agent</TaskCardLabel>
      {existingChat ? null : (
        <div className="-ml-1.5 flex min-w-0 flex-wrap items-center gap-0.5">
          <ScratchModelPickers
            draft={draft}
            catalog={catalog}
            providerStatuses={providerStatuses}
          />
          <TaskDelegateTargetPicker runIn={runIn} />
        </div>
      )}

      {showsMore || existingChat ? (
        <div className="-ml-1.5 flex min-w-0 flex-wrap items-center gap-0.5">
          <TaskDelegateChatPicker chat={chat} />
          {existingChat ? null : <ScratchRuntimeControls draft={draft} catalog={catalog} />}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          aria-expanded={showsMore}
          onClick={() => setShowsMore((current) => !current)}
          className="text-ui-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
        >
          {showsMore ? "Fewer options" : "More options"}
        </button>
        <TaskActionButton
          disabled={!canStart}
          onClick={() => void handleStart()}
          className={cn("gap-2", isStarting && "cursor-progress")}
        >
          {isStarting ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
          Start
        </TaskActionButton>
      </div>
    </section>
  );
}
