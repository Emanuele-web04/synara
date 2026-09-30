// FILE: TaskDelegateForm.tsx
// Purpose: The inspector's "Delegate to an agent" form — hands the to-do to an agent chat.
//          The user picks a new chat (provider/model/effort, project or folder, access)
//          or an existing chat; Start links the chat to the to-do and sends the prompt.
//          Model state rides on a scratch composer draft so the shared composer
//          pickers (real provider icons, effort, fast mode) work unchanged. This file
//          composes the form; the start logic lives in useTaskDelegation.
// Layer: Tasks UI component
// Exports: TaskDelegateForm

import type { Todo, TodoUpdateInput } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";

import { useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { SubmitShortcutKbd } from "~/components/ui/kbd";
import { Textarea } from "~/components/ui/textarea";
import { useScratchComposerDraft } from "~/hooks/useScratchComposerDraft";
import { useScratchModelCatalog } from "~/hooks/useScratchModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { DelegateIcon, LoaderCircleIcon } from "~/lib/icons";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  ScratchModelPickers,
  ScratchRuntimeControls,
} from "~/components/chat/ScratchAgentControls";
import { TaskDelegateChatPicker } from "./TaskDelegateChatPicker";
import { TaskDelegateTargetPicker } from "./TaskDelegateTargetPicker";
import { buildDelegationPrompt } from "./tasks.logic";
import { useTaskDelegateChat } from "./useTaskDelegateChat";
import { useTaskDelegateTarget } from "./useTaskDelegateTarget";
import { useTaskDelegation } from "./useTaskDelegation";

/** One label + control pair of the form's two-column grid. */
function DelegateRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="text-ui-sm text-muted-foreground">{label}</span>
      {children}
    </>
  );
}

export function TaskDelegateForm({
  todo,
  onLinkChat,
  onDelegated,
  onCancel,
}: {
  todo: Todo;
  /** Records the chat on the to-do; runs before anything is sent, and throwing aborts. */
  onLinkChat: (input: TodoUpdateInput) => Promise<unknown>;
  onDelegated?: () => void;
  onCancel?: () => void;
}) {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const providerStatuses = useProviderStatusesForLocalConfig();
  const draft = useScratchComposerDraft({
    defaultProvider: settings.defaultProvider,
    settings,
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
    onDelegated,
    draft,
    catalog,
    providerStatuses,
    target,
    existingChat,
  });

  return (
    <div
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void handleStart();
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <DelegateIcon className="size-3.5 shrink-0 text-status-merged" />
        <span className="text-ui font-medium text-foreground">Delegate to an agent</span>
      </div>

      <Textarea
        aria-label="Instructions for the agent"
        size="sm"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        className="text-ui"
      />

      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
        <DelegateRow label="Chat">
          <TaskDelegateChatPicker chat={chat} />
        </DelegateRow>

        {existingChat ? null : (
          <>
            <DelegateRow label="Model">
              <div className="flex min-w-0 items-center gap-1">
                <ScratchModelPickers
                  draft={draft}
                  catalog={catalog}
                  providerStatuses={providerStatuses}
                />
              </div>
            </DelegateRow>
            <DelegateRow label="Run in">
              <TaskDelegateTargetPicker runIn={runIn} />
            </DelegateRow>
            <DelegateRow label="Access">
              <ScratchRuntimeControls draft={draft} catalog={catalog} />
            </DelegateRow>
          </>
        )}
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-border pt-3">
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={!canStart}
          onClick={() => void handleStart()}
          className={cn("gap-2", isStarting && "cursor-progress")}
        >
          {isStarting ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
          Start
          <SubmitShortcutKbd className="bg-primary-foreground/15 text-primary-foreground/80" />
        </Button>
      </div>
    </div>
  );
}
