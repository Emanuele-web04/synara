// FILE: TaskHandOff.tsx
// Purpose: The task card's "Hand it to an agent" controls: which agent and model, where it
//          runs, and Start. The agent gets the to-do's title and note, so there is no second
//          prompt to fill in. The rest — reusing an existing chat, access — sits behind "More
//          options". Model state rides on a scratch composer draft so the shared composer
//          pickers work unchanged; the start logic lives in useTaskDelegation. The card can
//          start it too (⌘↵ anywhere on it) through `startRef`.
// Layer: Tasks UI component
// Exports: TaskHandOff

import type { Todo, TodoUpdateInput } from "@synara/contracts";
import { applyClaudePromptEffortPrefix, isClaudeUltrathinkPrompt } from "@synara/shared/model";
import { useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect, useState } from "react";

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
  readTodo,
  onLinkChat,
  startRef,
}: {
  todo: Todo;
  /** The to-do with any title or note edit already saved, even one its render hasn't seen. */
  readTodo: () => Todo;
  /** Records the chat on the to-do; runs before anything is sent, and throwing aborts. */
  onLinkChat: (input: TodoUpdateInput) => Promise<unknown>;
  /** Set to this hand-off's Start while it is mounted. */
  startRef: RefObject<(() => void) | null>;
}) {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const providerStatuses = useProviderStatusesForLocalConfig();
  const draft = useScratchComposerDraft({
    defaultProvider: settings.defaultProvider,
    settings,
    initialPrompt: buildDelegationPrompt(todo),
  });
  const { scratchThreadId } = draft;
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

  // The agent gets the to-do's latest title and note. Picking Ultrathink writes its keyword
  // into the draft's prompt, so that choice is read from there.
  const readPrompt = () => {
    const prompt = buildDelegationPrompt(readTodo());
    const draftPrompt = useComposerDraftStore.getState().draftsByThreadId[scratchThreadId]?.prompt;
    return isClaudeUltrathinkPrompt(draftPrompt) && !isClaudeUltrathinkPrompt(prompt)
      ? applyClaudePromptEffortPrefix(prompt, "ultrathink")
      : prompt;
  };

  const { isStarting, canStart, handleStart } = useTaskDelegation({
    todo,
    onLinkChat,
    onDelegated: undefined,
    readPrompt,
    draft,
    catalog,
    providerStatuses,
    target,
    existingChat,
  });
  useEffect(() => {
    startRef.current = () => void handleStart();
    return () => {
      startRef.current = null;
    };
  });

  return (
    <section aria-label="Hand it to an agent" className="flex flex-col gap-1.5">
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
