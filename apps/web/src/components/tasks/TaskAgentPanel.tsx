// FILE: TaskAgentPanel.tsx
// Purpose: What the task card shows once a to-do is with an agent: one soft block per state
//          — working (with its last steps), needs your OK (Allow / Deny), a question to
//          answer in the chat, ready for you (the reply), or stopped — headed by the agent's
//          icon and one line, then the one or two things to do next on a right-aligned row.
// Layer: Tasks UI component
// Exports: TaskAgentPanel

import { PROVIDER_DISPLAY_NAMES, type ThreadId, type TodoUpdateInput } from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";

import ChatMarkdown from "~/components/ChatMarkdown";
import { ComposerPendingApprovalPanel } from "~/components/chat/ComposerPendingApprovalPanel";
import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";
import type { PendingApproval } from "../../session-logic";
import { TaskActionButton, TaskActionRow, TaskPillButton, TaskWell } from "./TaskCardPrimitives";
import {
  describeAgentLocation,
  formatAgentActivity,
  NEEDS_ANSWER_DETAIL,
  type TaskRowModel,
} from "./tasks.logic";
import { useOpenChat } from "./useOpenChat";
import { useTaskAgentActions, useTaskAgentThread } from "./useTaskAgent";

const APPROVAL_ASK: Record<PendingApproval["requestKind"], string> = {
  command: "wants to run a command",
  "file-read": "wants to read a file",
  "file-change": "wants to change a file",
  permissions: "wants more permissions",
  tool: "wants to use a tool",
};

export function TaskAgentPanel({
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
  const openChat = useOpenChat(threadId);
  const { thread, pendingApprovals, hasPendingUserInput, recentActivity, latestReply } =
    useTaskAgentThread(threadId, status.kind);
  const { respondingKey, isStopping, respondToApproval, stop } = useTaskAgentActions(
    threadId,
    thread?.runtimeMode,
  );

  if (!summary) return null;
  const provider = summary.modelSelection.provider;
  const agentName = PROVIDER_DISPLAY_NAMES[provider];
  const location = describeAgentLocation(summary, projectNameById);
  const fullPath = summary.workingDirectory ?? projectCwdById.get(summary.projectId) ?? null;
  const model =
    formatModelDisplayName(summary.modelSelection.model) ?? summary.modelSelection.model;
  // Only the delegated turn's own requests: while a reused chat is still on its earlier
  // turn (Starting), those belong to other work.
  const approval = status.kind === "needs" ? pendingApprovals[0] : undefined;
  // The row's status comes from the chat summary; the request itself only arrives with the
  // chat's details, which may lag or never load here. Without it, the chat is where to act.
  const asksQuestion =
    status.kind === "needs" &&
    !approval &&
    (hasPendingUserInput || status.detail === NEEDS_ANSWER_DETAIL);
  const awaitsOk = status.kind === "needs" && !approval && !asksQuestion;
  const markDone = () => onUpdate({ id: todo.id, completed: true });

  // The agent's icon and one line open each block; the model and place are its tooltip.
  const headline = (text: string, className?: string) => (
    <div
      className="flex min-w-0 items-center gap-2"
      title={`${agentName} · ${model}${location ? ` · in ${fullPath ?? location}` : ""}`}
    >
      <ProviderIcon provider={provider} className="size-3.5 shrink-0" />
      <span className={cn("min-w-0 text-ui-sm text-foreground", className)}>{text}</span>
    </div>
  );

  return (
    <section aria-label={`${agentName} · ${model}`} className="flex flex-col gap-2">
      {status.kind === "running" || status.kind === "starting" ? (
        <>
          <TaskWell>
            {headline(
              status.kind === "running" ? `${agentName} is working on it` : "Starting…",
              "shimmer",
            )}
            {recentActivity.map((entry) => (
              <span
                key={entry.id}
                className="min-w-0 truncate pl-5.5 text-ui-xs text-muted-foreground"
              >
                {entry.toolTitle ?? entry.label}
              </span>
            ))}
          </TaskWell>
          <TaskActionRow>
            {/* Not while Starting: a reused chat may still be on its earlier turn, and Stop
                interrupts whatever turn is active. */}
            {status.kind === "running" ? (
              <TaskPillButton disabled={isStopping} onClick={() => void stop()}>
                Stop
              </TaskPillButton>
            ) : null}
            <TaskPillButton onClick={openChat}>Open chat</TaskPillButton>
          </TaskActionRow>
        </>
      ) : null}

      {approval?.approvalScope ? (
        // Computer and device consent have their own scoped choices; keep the full panel.
        <ComposerPendingApprovalPanel
          approval={approval}
          pendingCount={pendingApprovals.length}
          isResponding={respondingKey === approval.requestId}
          onRespond={respondToApproval}
        />
      ) : approval ? (
        <>
          <TaskWell>
            {headline(`${agentName} ${APPROVAL_ASK[approval.requestKind]}`)}
            {approval.detail ? (
              <span className="line-clamp-3 font-mono text-ui-xs break-all text-muted-foreground">
                {approval.detail}
              </span>
            ) : null}
          </TaskWell>
          <TaskActionRow>
            <button
              type="button"
              onClick={openChat}
              className="mr-auto text-ui-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
            >
              More choices
            </button>
            <TaskPillButton
              disabled={respondingKey === approval.requestId}
              onClick={() =>
                void respondToApproval(
                  approval.requestId,
                  "decline",
                  approval.lifecycleGeneration,
                  approval.requestKind,
                )
              }
            >
              Deny
            </TaskPillButton>
            <TaskActionButton
              disabled={respondingKey === approval.requestId}
              onClick={() =>
                void respondToApproval(
                  approval.requestId,
                  "accept",
                  approval.lifecycleGeneration,
                  approval.requestKind,
                )
              }
            >
              Allow
            </TaskActionButton>
          </TaskActionRow>
        </>
      ) : null}

      {asksQuestion ? (
        <>
          <TaskWell>{headline(`${agentName} asked you a question`)}</TaskWell>
          <TaskActionRow>
            <TaskActionButton onClick={openChat}>Answer in the chat</TaskActionButton>
          </TaskActionRow>
        </>
      ) : null}

      {awaitsOk ? (
        <>
          <TaskWell>{headline(`${agentName} is waiting for your OK`)}</TaskWell>
          <TaskActionRow>
            <TaskActionButton onClick={openChat}>Open chat</TaskActionButton>
          </TaskActionRow>
        </>
      ) : null}

      {status.kind === "review" ? (
        <>
          <TaskWell>
            {headline(formatAgentActivity(status, summary) ?? "Finished", "text-muted-foreground")}
            {latestReply ? (
              <div className="max-h-72 overflow-y-auto">
                <ChatMarkdown
                  text={latestReply}
                  cwd={summary.worktreePath ?? fullPath ?? undefined}
                  className="text-ui-sm leading-relaxed"
                />
              </div>
            ) : null}
          </TaskWell>
          <TaskActionRow>
            <TaskPillButton onClick={openChat}>Open chat</TaskPillButton>
            <TaskActionButton onClick={markDone}>Mark as done</TaskActionButton>
          </TaskActionRow>
        </>
      ) : null}

      {status.kind === "stopped" ? (
        <>
          <TaskWell>
            {headline(status.label, "text-status-failure")}
            {status.detail ? (
              <span className="pl-5.5 text-ui-xs text-muted-foreground">{status.detail}</span>
            ) : null}
          </TaskWell>
          <TaskActionRow>
            <TaskPillButton onClick={openChat}>Open chat</TaskPillButton>
            <TaskPillButton onClick={markDone}>Mark as done</TaskPillButton>
          </TaskActionRow>
        </>
      ) : null}
    </section>
  );
}
