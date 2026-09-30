// FILE: TaskAgentSection.tsx
// Purpose: The inspector's agent section for a delegated to-do: the chat's model and folder,
//          recent activity, and the action it needs — approve a request inline, stop, review
//          the reply, mark done.
// Layer: Tasks UI component
// Exports: TaskAgentSection

import type { ThreadId, TodoUpdateInput } from "@synara/contracts";

import ChatMarkdown from "~/components/ChatMarkdown";
import { ComposerPendingApprovalPanel } from "~/components/chat/ComposerPendingApprovalPanel";
import { Button } from "~/components/ui/button";
import { TaskStatusChip } from "./TaskGlyphs";
import { TaskAgentActivityList, TaskAgentDetails } from "./TaskAgentDetails";
import { TaskNotice, TaskSectionLabel } from "./TaskInspectorPrimitives";
import { describeAgentLocation, formatAgentActivity, type TaskRowModel } from "./tasks.logic";
import { useOpenChat } from "./useOpenChat";
import { useTaskAgentActions, useTaskAgentThread } from "./useTaskAgent";

export function TaskAgentSection({
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
  const location = describeAgentLocation(summary, projectNameById);
  const fullPath = summary.workingDirectory ?? projectCwdById.get(summary.projectId) ?? null;
  const activity = formatAgentActivity(status, summary);
  const approval = pendingApprovals[0];

  return (
    <section aria-label="Agent" className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2">
        <TaskSectionLabel>Agent</TaskSectionLabel>
        <div className="flex-1" />
        <TaskStatusChip kind={status.kind} label={status.label} />
      </div>

      <TaskAgentDetails
        summary={summary}
        location={location}
        fullPath={fullPath}
        onOpenChat={openChat}
      />

      {recentActivity.length > 0 ? (
        <TaskAgentActivityList entries={recentActivity} />
      ) : activity ? (
        <TaskNotice>{activity}</TaskNotice>
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
        <TaskNotice tone="warning" action={{ label: "Answer in chat", onClick: openChat }}>
          The agent asked you a question.
        </TaskNotice>
      ) : null}

      {status.kind === "stopped" && status.detail ? (
        <TaskNotice tone="failure">{status.detail}</TaskNotice>
      ) : null}

      {latestReply ? (
        <div className="flex flex-col gap-1.5">
          <TaskSectionLabel>Latest reply</TaskSectionLabel>
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
