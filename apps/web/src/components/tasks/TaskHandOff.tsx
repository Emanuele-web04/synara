// FILE: TaskHandOff.tsx
// Purpose: The task card's "Hand it to an agent" form: what to do (seeded from the to-do),
//          which agent and model, where it runs, and Start. The rest — reusing an existing
//          chat, access, effort — sits behind "More options". Model state rides on a scratch
//          composer draft so the shared composer pickers work unchanged; the start logic
//          lives in useTaskDelegation.
// Layer: Tasks UI component
// Exports: TaskHandOff

import type { Todo, TodoUpdateInput } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

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
import { TaskActionButton, TaskCardLabel, TaskWell } from "./TaskCardPrimitives";
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
  const { scratchThreadId, prompt, setPrompt } = draft;
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

  // The prompt follows the to-do's title and notes until the user edits it.
  const delegationPrompt = buildDelegationPrompt(todo);
  const seededPromptRef = useRef(delegationPrompt);
  useEffect(() => {
    if (delegationPrompt === seededPromptRef.current) return;
    const current = useComposerDraftStore.getState().draftsByThreadId[scratchThreadId]?.prompt;
    if (current === undefined || current === seededPromptRef.current) {
      seededPromptRef.current = delegationPrompt;
      setPrompt(delegationPrompt);
    }
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
      className="flex flex-col gap-2.5"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void handleStart();
        }
      }}
    >
      <TaskCardLabel>Hand it to an agent</TaskCardLabel>
      <TaskWell className="py-3">
        <textarea
          aria-label="What should the agent do?"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          className="font-system-ui field-sizing-content max-h-48 min-h-16 w-full resize-none bg-transparent text-ui leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
        />
      </TaskWell>

      {existingChat ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <ScratchModelPickers
            draft={draft}
            catalog={catalog}
            providerStatuses={providerStatuses}
          />
          <TaskDelegateTargetPicker runIn={runIn} />
        </div>
      )}

      {showsMore || existingChat ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
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
