// FILE: TaskAgentPanel.tsx
// Purpose: What the task card shows once a to-do is with an agent, in one soft block per
//          state: working (with its last steps), needs your OK (Allow / Deny), a question to
//          answer in the chat, ready for you (the reply), or stopped. Each ends with the one
//          or two things to do next.
// Layer: Tasks UI component
// Exports: TaskAgentPanel

import { PROVIDER_DISPLAY_NAMES, type ThreadId, type TodoUpdateInput } from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";

import ChatMarkdown from "~/components/ChatMarkdown";
import { ComposerPendingApprovalPanel } from "~/components/chat/ComposerPendingApprovalPanel";
import { ProviderIcon } from "~/components/ProviderIcon";
import type { PendingApproval } from "../../session-logic";
import { TaskActionButton, TaskPillButton, TaskWell } from "./TaskCardPrimitives";
import { describeAgentLocation, formatAgentActivity, type TaskRowModel } from "./tasks.logic";
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
  // Only the delegated turn's own requests: while a reused chat is still on its earlier
  // turn (Starting), those belong to other work.
  const approval = status.kind === "needs" ? pendingApprovals[0] : undefined;
  const asksQuestion = status.kind === "needs" && !approval && hasPendingUserInput;
  const markDone = () => onUpdate({ id: todo.id, completed: true });

  return (
    <section aria-label="Agent" className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-1.5 text-ui-sm text-muted-foreground">
        <ProviderIcon provider={provider} className="size-3.5 shrink-0" />
        <span className="shrink-0 text-foreground/80">{agentName}</span>
        <span className="min-w-0 truncate">
          {formatModelDisplayName(summary.modelSelection.model) ?? summary.modelSelection.model}
        </span>
        {location ? (
          <span className="min-w-0 truncate" title={fullPath ?? undefined}>
            · in {location}
          </span>
        ) : null}
      </div>

      {status.kind === "running" || status.kind === "starting" ? (
        <>
          <TaskWell>
            <span className="shimmer text-ui">
              {status.kind === "running" ? `${agentName} is working on it` : "Starting…"}
            </span>
            {recentActivity.map((entry) => (
              <span key={entry.id} className="min-w-0 truncate text-ui-sm text-muted-foreground">
                {entry.toolTitle ?? entry.label}
              </span>
            ))}
          </TaskWell>
          <div className="flex gap-2">
            {/* Not while Starting: a reused chat may still be on its earlier turn, and Stop
                interrupts whatever turn is active. */}
            {status.kind === "running" ? (
              <TaskPillButton className="flex-1" disabled={isStopping} onClick={() => void stop()}>
                Stop
              </TaskPillButton>
            ) : null}
            <TaskPillButton className="flex-1" onClick={openChat}>
              Open chat
            </TaskPillButton>
          </div>
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
            <span className="text-ui text-foreground">
              {agentName} {APPROVAL_ASK[approval.requestKind]}
            </span>
            {approval.detail ? (
              <span className="line-clamp-3 font-mono text-ui-xs break-all text-muted-foreground">
                {approval.detail}
              </span>
            ) : null}
          </TaskWell>
          <div className="flex flex-col gap-2">
            <TaskActionButton
              size="default"
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
            <TaskPillButton
              size="default"
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
            <button
              type="button"
              onClick={openChat}
              className="self-center text-ui-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
            >
              More choices in the chat
            </button>
          </div>
        </>
      ) : null}

      {asksQuestion ? (
        <>
          <TaskWell>
            <span className="text-ui text-foreground">{agentName} asked you a question</span>
          </TaskWell>
          <TaskActionButton onClick={openChat}>Answer in the chat</TaskActionButton>
        </>
      ) : null}

      {status.kind === "review" ? (
        <>
          <TaskWell>
            <span className="text-ui-sm text-muted-foreground">
              {formatAgentActivity(status, summary) ?? "Finished"}
            </span>
            {latestReply ? (
              <div className="max-h-64 overflow-y-auto">
                <ChatMarkdown
                  text={latestReply}
                  cwd={summary.worktreePath ?? fullPath ?? undefined}
                  className="text-ui leading-relaxed"
                />
              </div>
            ) : null}
          </TaskWell>
          <div className="flex gap-2">
            <TaskPillButton className="flex-1" onClick={openChat}>
              Open chat
            </TaskPillButton>
            <TaskActionButton className="flex-1" onClick={markDone}>
              Mark as done
            </TaskActionButton>
          </div>
        </>
      ) : null}

      {status.kind === "stopped" ? (
        <>
          <TaskWell>
            <span className="text-ui text-status-failure">{status.label}</span>
            {status.detail ? (
              <span className="text-ui-sm text-muted-foreground">{status.detail}</span>
            ) : null}
          </TaskWell>
          <div className="flex gap-2">
            <TaskPillButton className="flex-1" onClick={openChat}>
              Open chat
            </TaskPillButton>
            <TaskPillButton className="flex-1" onClick={markDone}>
              Mark as done
            </TaskPillButton>
          </div>
        </>
      ) : null}
    </section>
  );
}
