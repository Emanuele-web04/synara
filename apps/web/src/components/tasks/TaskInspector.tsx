// FILE: TaskInspector.tsx
// Purpose: Right-hand detail panel for the selected to-do: editable title and notes,
//          properties, and the agent section — the delegate form for a plain to-do, or,
//          once delegated, the chat's model and folder, recent activity, and the action
//          it needs (approve a request inline, stop, review the reply, mark done).
// Layer: Tasks UI component
// Exports: TaskInspector

import {
  type ApprovalRequestId,
  PROVIDER_DISPLAY_NAMES,
  type ProjectId,
  type ProviderApprovalDecision,
  type ThreadId,
  type TodoUpdateInput,
} from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { ProviderIcon } from "~/components/ProviderIcon";
import { ComposerPendingApprovalPanel } from "~/components/chat/ComposerPendingApprovalPanel";
import { isReasoningUpdateWorkEntry } from "~/components/chat/agentActivity.logic";
import { respondToThreadApproval } from "~/components/chat/respondToThreadApproval";
import { Button } from "~/components/ui/button";
import { IconButton } from "~/components/ui/icon-button";
import { toastManager } from "~/components/ui/toast";
import { ArrowUpRightIcon, CalendarIcon, FolderIcon, XIcon } from "~/lib/icons";
import { interruptThreadTurn } from "~/lib/threadTurnInterrupt";
import { cn } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  canSessionAnswerPendingRequests,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveWorkLogEntries,
} from "../../session-logic";
import { useStore } from "../../store";
import { createThreadSelector } from "../../storeSelectors";
import { retainThreadDetailSubscription } from "../../threadDetailSubscriptionRetention";
import { TaskDelegateForm } from "./TaskDelegateForm";
import { TaskPriorityGlyph, TaskStatusChip, TaskStatusGlyph } from "./TaskGlyphs";
import { TaskDueMenu, TaskPriorityMenu, TaskProjectMenu } from "./TaskPropertyMenus";
import {
  describeAgentLocation,
  formatAgentActivity,
  formatDueLabel,
  type TaskRowModel,
  todoPriorityLabel,
} from "./tasks.logic";

const RECENT_ACTIVITY_LIMIT = 4;
const PROPERTY_VALUE_CLASS =
  "h-7 w-fit max-w-full justify-start gap-1.5 px-2 text-ui font-normal text-foreground";

interface TaskInspectorProps {
  row: TaskRowModel;
  projectNameById: ReadonlyMap<string, string>;
  projectCwdById: ReadonlyMap<string, string>;
  projectOptions: ReadonlyArray<{ id: ProjectId; name: string }>;
  now: Date;
  onUpdate: (input: TodoUpdateInput) => void;
  onUpdateAsync: (input: TodoUpdateInput) => Promise<unknown>;
  onClose: () => void;
}

export function TaskInspector({
  row,
  projectNameById,
  projectCwdById,
  projectOptions,
  now,
  onUpdate,
  onUpdateAsync,
  onClose,
}: TaskInspectorProps) {
  const { todo, status, thread } = row;
  const navigate = useNavigate();
  const due = todo.dueDate ? formatDueLabel(todo.dueDate, now) : null;
  const projectName = todo.projectId ? (projectNameById.get(todo.projectId) ?? null) : null;
  const isDone = status.kind === "done";

  return (
    <aside
      aria-label="Task details"
      className="flex w-[24rem] shrink-0 flex-col overflow-y-auto border-l border-border bg-card/40"
    >
      <div className="flex flex-col gap-5 px-5 pt-3.5 pb-6">
        <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
          <TaskStatusGlyph kind={status.kind} className="size-3.5" />
          <span>{status.label}</span>
          <div className="flex-1" />
          <IconButton label="Close details" size="icon-xs" variant="ghost" onClick={onClose}>
            <XIcon className="size-3.5" />
          </IconButton>
        </div>

        {/* Keyed by id so switching the selection never carries a half-typed edit over. */}
        <TaskTextFields key={todo.id} row={row} onUpdate={onUpdate} />

        <dl className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
          <dt className="text-ui-sm text-muted-foreground">Priority</dt>
          <dd>
            <TaskPriorityMenu
              priority={todo.priority}
              onChange={(priority) => onUpdate({ id: todo.id, priority })}
              trigger={<Button size="xs" variant="ghost" className={PROPERTY_VALUE_CLASS} />}
            >
              <TaskPriorityGlyph priority={todo.priority} />
              {todoPriorityLabel(todo.priority)}
            </TaskPriorityMenu>
          </dd>
          <dt className="text-ui-sm text-muted-foreground">Project</dt>
          <dd>
            <TaskProjectMenu
              projectId={todo.projectId}
              projectOptions={projectOptions}
              onChange={(projectId) => onUpdate({ id: todo.id, projectId })}
              trigger={
                <Button
                  size="xs"
                  variant="ghost"
                  className={cn(PROPERTY_VALUE_CLASS, !projectName && "text-muted-foreground")}
                />
              }
            >
              <FolderIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
              <span className="min-w-0 truncate">{projectName ?? "No project"}</span>
            </TaskProjectMenu>
          </dd>
          <dt className="text-ui-sm text-muted-foreground">Due</dt>
          <dd>
            <TaskDueMenu
              dueDate={todo.dueDate}
              now={now}
              onChange={(dueDate) => onUpdate({ id: todo.id, dueDate })}
              trigger={
                <Button
                  size="xs"
                  variant="ghost"
                  className={cn(
                    PROPERTY_VALUE_CLASS,
                    !due && "text-muted-foreground",
                    due?.overdue && "text-status-failure",
                  )}
                />
              }
            >
              <CalendarIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
              {due ? due.label : "No due date"}
            </TaskDueMenu>
          </dd>
        </dl>

        <div className="h-px bg-border" />

        {thread ? (
          <TaskAgentSection
            key={thread.id}
            row={row}
            threadId={thread.id}
            projectNameById={projectNameById}
            projectCwdById={projectCwdById}
            onUpdate={onUpdate}
          />
        ) : isDone ? (
          <p className="text-ui-sm text-muted-foreground">Done. Reopen it to delegate it again.</p>
        ) : todo.threadId !== null && !status.chatMissing ? (
          // Linked, but the chat has not reached the server yet: no second Start meanwhile.
          <div className="flex items-center gap-2">
            <p className="flex-1 text-ui-sm text-muted-foreground">
              {status.detail ?? "Starting the agent…"}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (todo.threadId) {
                  void navigate({ to: "/$threadId", params: { threadId: todo.threadId } });
                }
              }}
            >
              Open chat
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {status.chatMissing ? (
              <div className="flex items-center gap-2">
                <p className="flex-1 text-ui-sm text-muted-foreground">
                  The chat this task was delegated to no longer exists.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onUpdate({ id: todo.id, threadId: null })}
                >
                  Unlink
                </Button>
              </div>
            ) : null}
            <TaskDelegateForm key={todo.id} todo={todo} onLinkChat={onUpdateAsync} />
          </div>
        )}
      </div>
    </aside>
  );
}

function TaskTextFields({
  row,
  onUpdate,
}: {
  row: TaskRowModel;
  onUpdate: (input: TodoUpdateInput) => void;
}) {
  const { todo } = row;
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes);
  // Adopt remote edits (another window, the row's inline rename) when not mid-edit.
  const [focusedField, setFocusedField] = useState<"title" | "notes" | null>(null);
  useEffect(() => {
    if (focusedField !== "title") setTitle(todo.title);
  }, [focusedField, todo.title]);
  useEffect(() => {
    if (focusedField !== "notes") setNotes(todo.notes);
  }, [focusedField, todo.notes]);

  // Escape blurs the field too; the blur must not save what Escape discarded.
  const discardTitleOnBlurRef = useRef(false);
  const commitTitle = () => {
    setFocusedField(null);
    if (discardTitleOnBlurRef.current) {
      discardTitleOnBlurRef.current = false;
      setTitle(todo.title);
      return;
    }
    const next = title.trim();
    if (next.length === 0) {
      setTitle(todo.title);
    } else if (next !== todo.title) {
      onUpdate({ id: todo.id, title: next });
    }
  };
  const commitNotes = () => {
    setFocusedField(null);
    if (notes !== todo.notes) onUpdate({ id: todo.id, notes });
  };
  const handleTitleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      discardTitleOnBlurRef.current = true;
      event.currentTarget.blur();
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        aria-label="Task title"
        rows={1}
        value={title}
        onFocus={() => setFocusedField("title")}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={commitTitle}
        onKeyDown={handleTitleKeyDown}
        className="font-system-ui field-sizing-content w-full resize-none bg-transparent text-ui-lg font-medium leading-snug text-foreground outline-none"
      />
      <textarea
        aria-label="Notes"
        rows={2}
        value={notes}
        placeholder="Add notes…"
        onFocus={() => setFocusedField("notes")}
        onChange={(event) => setNotes(event.target.value)}
        onBlur={commitNotes}
        className="font-system-ui field-sizing-content min-h-10 w-full resize-none bg-transparent text-ui leading-relaxed text-muted-foreground outline-none placeholder:text-muted-foreground/60 focus:text-foreground"
      />
    </div>
  );
}

function TaskAgentSection({
  row,
  threadId,
  projectNameById,
  projectCwdById,
  onUpdate,
}: {
  row: TaskRowModel;
  threadId: ThreadId;
  projectNameById: ReadonlyMap<string, string>;
  projectCwdById: ReadonlyMap<string, string>;
  onUpdate: (input: TodoUpdateInput) => void;
}) {
  const { todo, status } = row;
  const summary = row.thread;
  const navigate = useNavigate();
  // Activities and pending requests live on the thread detail, which is only streamed
  // for subscribed threads — hold one for as long as the inspector shows this chat.
  useEffect(() => retainThreadDetailSubscription(threadId), [threadId]);
  const thread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const [respondingKey, setRespondingKey] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);

  const canAnswer = canSessionAnswerPendingRequests(thread?.session ?? null);
  const latestTurnId = thread?.latestTurn?.turnId;
  const pendingApprovals = useMemo(
    () =>
      thread && canAnswer
        ? derivePendingApprovals(thread.activities, thread.pendingInteractions, {
            authoritativeHasPending: thread.hasPendingApprovals,
            latestTurnId,
          })
        : [],
    [canAnswer, latestTurnId, thread],
  );
  const hasPendingUserInput = useMemo(
    () =>
      thread && canAnswer
        ? derivePendingUserInputs(thread.activities, thread.pendingInteractions, {
            authoritativeHasPending: thread.hasPendingUserInput,
            latestTurnId,
          }).length > 0
        : false,
    [canAnswer, latestTurnId, thread],
  );
  const recentActivity = useMemo(() => {
    if (!thread || !latestTurnId) return [];
    return (
      deriveWorkLogEntries(thread.activities, latestTurnId, {
        visibleTurnIds: new Set([latestTurnId]),
        activeTurnId: status.kind === "running" ? latestTurnId : null,
        activeTurnStartedAt: thread.latestTurn?.startedAt ?? null,
        latestTurnState: thread.latestTurn?.state ?? null,
        latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
      })
        // Reasoning is the chat's to show; approval rows restate the inline approval card.
        .filter(
          (entry) =>
            entry.tone !== "thinking" &&
            !isReasoningUpdateWorkEntry(entry) &&
            entry.activityKind !== "approval.requested" &&
            entry.activityKind !== "approval.resolved",
        )
        .slice(-RECENT_ACTIVITY_LIMIT)
    );
  }, [latestTurnId, status.kind, thread]);
  const latestReply = useMemo(() => {
    if (!thread || status.kind !== "review") return null;
    // Only the delegated (latest) turn's answer; an older one in a reused chat isn't it.
    const reply = thread.messages.findLast(
      (message) =>
        message.role === "assistant" &&
        message.turnId === latestTurnId &&
        message.text.trim().length > 0,
    );
    return reply?.text.trim() ?? null;
  }, [latestTurnId, status.kind, thread]);

  if (!summary) return null;
  const provider = summary.modelSelection.provider;
  const location = describeAgentLocation(summary, projectNameById);
  const fullPath = summary.workingDirectory ?? projectCwdById.get(summary.projectId) ?? null;
  const activity = formatAgentActivity(status, summary);
  const approval = pendingApprovals[0];
  const openChat = () => void navigate({ to: "/$threadId", params: { threadId } });

  const respondToApproval = async (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
    lifecycleGeneration?: string,
    requestKind?: (typeof pendingApprovals)[number]["requestKind"],
  ) => {
    setRespondingKey(requestId);
    try {
      await respondToThreadApproval({
        threadId,
        requestId,
        decision,
        lifecycleGeneration,
        requestKind,
        runtimeMode:
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode ??
          thread?.runtimeMode ??
          "approval-required",
      });
    } catch (error) {
      // The chat shows the error too, but this panel is where the user answered.
      toastManager.add({
        type: "error",
        title: "Couldn't send your answer",
        description: error instanceof Error ? error.message : "Try again from the chat.",
      });
    } finally {
      setRespondingKey(null);
    }
  };
  const stop = async () => {
    setIsStopping(true);
    try {
      await interruptThreadTurn(threadId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't stop the agent",
        description: error instanceof Error ? error.message : "Unexpected error.",
      });
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <section aria-label="Agent" className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2">
        <span className="text-ui-sm font-medium text-muted-foreground">Agent</span>
        <div className="flex-1" />
        <TaskStatusChip kind={status.kind} label={status.label} />
      </div>

      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-2.5 rounded-xl border border-border px-3 py-2.5 text-ui">
        <dt className="text-ui-sm text-muted-foreground">Model</dt>
        <dd className="flex min-w-0 items-center gap-1.5">
          <ProviderIcon provider={provider} className="size-3.5 shrink-0" />
          <span className="shrink-0 text-muted-foreground">{PROVIDER_DISPLAY_NAMES[provider]}</span>
          <span className="min-w-0 truncate">
            {formatModelDisplayName(summary.modelSelection.model) ?? summary.modelSelection.model}
          </span>
        </dd>
        <dt className="text-ui-sm text-muted-foreground">Runs in</dt>
        <dd className="flex min-w-0 items-center gap-1.5" title={fullPath ?? undefined}>
          <FolderIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 truncate font-mono text-ui-sm">{location ?? "Unknown"}</span>
          {summary.envMode === "worktree" && summary.branch ? (
            <span className="min-w-0 truncate rounded-md bg-muted px-1.5 font-mono text-ui-xs text-muted-foreground">
              {summary.branch}
            </span>
          ) : null}
        </dd>
        <dt className="text-ui-sm text-muted-foreground">Chat</dt>
        <dd className="min-w-0">
          <button
            type="button"
            onClick={openChat}
            className="flex max-w-full items-center gap-1 text-left text-foreground hover:underline"
          >
            <span className="min-w-0 truncate">{summary.title}</span>
            <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
          </button>
        </dd>
      </dl>

      {recentActivity.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-ui-sm font-medium text-muted-foreground">Activity</span>
          <ol className="flex flex-col gap-1">
            {recentActivity.map((entry) => (
              <li key={entry.id} className="flex min-w-0 items-baseline gap-2 text-ui-sm">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
                    entry.tone === "error" ? "bg-status-failure" : "bg-muted-foreground/50",
                  )}
                />
                <span className="shrink-0 text-foreground/85">
                  {entry.toolTitle ?? entry.label}
                </span>
                {(entry.command ?? entry.detail) ? (
                  <span className="min-w-0 truncate font-mono text-ui-xs text-muted-foreground">
                    {entry.command ?? entry.detail}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : activity ? (
        <p className="text-ui-sm text-muted-foreground">{activity}</p>
      ) : null}

      {/* Only the delegated turn's own approvals: while a reused chat is still on its
          earlier turn (Starting), those belong to other work. */}
      {approval && status.kind === "needs" ? (
        <ComposerPendingApprovalPanel
          approval={approval}
          pendingCount={pendingApprovals.length}
          isResponding={respondingKey === approval.requestId}
          onRespond={respondToApproval}
        />
      ) : null}

      {!approval && hasPendingUserInput && status.kind === "needs" ? (
        <div className="flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/8 px-3 py-2.5">
          <span className="flex-1 text-ui-sm text-foreground">The agent asked you a question.</span>
          <Button size="xs" onClick={openChat}>
            Answer in chat
          </Button>
        </div>
      ) : null}

      {status.kind === "stopped" && status.detail ? (
        <p className="rounded-xl border border-status-failure/25 bg-status-failure/6 px-3 py-2.5 text-ui-sm text-foreground">
          {status.detail}
        </p>
      ) : null}

      {latestReply ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-ui-sm font-medium text-muted-foreground">Latest reply</span>
          <div className="max-h-56 overflow-y-auto">
            <ChatMarkdown
              text={latestReply}
              cwd={summary.worktreePath ?? fullPath ?? undefined}
              className="text-ui-sm leading-relaxed"
            />
          </div>
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        {/* Not while Starting: a reused chat may still be on its earlier turn, and Stop
            interrupts whatever turn is active. */}
        {status.kind === "running" ? (
          <Button size="sm" variant="outline" disabled={isStopping} onClick={() => void stop()}>
            Stop
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={status.kind === "review" ? "outline" : "default"}
          onClick={openChat}
        >
          Open chat
        </Button>
        {status.kind === "review" ? (
          <Button size="sm" onClick={() => onUpdate({ id: todo.id, completed: true })}>
            Mark done
          </Button>
        ) : null}
      </div>
    </section>
  );
}
