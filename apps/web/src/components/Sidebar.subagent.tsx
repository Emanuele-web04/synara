// FILE: Sidebar.subagent.tsx
// Purpose: Renders the subagent title/role label for sidebar thread rows.
// Layer: Sidebar UI (reads parent thread from the app store).
// Exports: SidebarSubagentLabel

import { useMemo } from "react";
import type { ThreadId } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { useStore } from "../store";
import { createThreadSelector } from "../storeSelectors";
import { resolveSubagentPresentationForThread } from "../lib/subagentPresentation";
import type { Thread } from "../types";

function renderSubagentLabel(input: {
  threadId: string;
  parentThreadId?: string | null | undefined;
  agentId?: string | null | undefined;
  nickname?: string | null | undefined;
  role?: string | null | undefined;
  title?: string | null | undefined;
  threads?: ReadonlyArray<Thread> | undefined;
  titleClassName?: string | undefined;
  roleClassName?: string | undefined;
}) {
  const presentation = resolveSubagentPresentationForThread({
    thread: {
      id: input.threadId,
      parentThreadId: input.parentThreadId,
      subagentAgentId: input.agentId,
      subagentNickname: input.nickname,
      subagentRole: input.role,
      title: input.title,
    },
    threads: input.threads,
  });
  const supportingLabel =
    presentation.role ??
    (presentation.nickname && presentation.title && presentation.title !== presentation.nickname
      ? presentation.title
      : null);

  return (
    <span className="min-w-0 truncate">
      <span
        className={cn("font-medium", input.titleClassName)}
        style={{ color: presentation.accentColor }}
      >
        {presentation.nickname ?? presentation.primaryLabel}
      </span>
      {supportingLabel ? (
        <span className={cn("ml-1 text-muted-foreground/70", input.roleClassName)}>
          {presentation.role ? `(${presentation.role})` : supportingLabel}
        </span>
      ) : null}
    </span>
  );
}

export function SidebarSubagentLabel(props: {
  threadId: ThreadId;
  parentThreadId?: ThreadId | null | undefined;
  agentId?: string | null | undefined;
  nickname?: string | null | undefined;
  role?: string | null | undefined;
  title?: string | null | undefined;
  titleClassName?: string | undefined;
  roleClassName?: string | undefined;
}) {
  const selectParentThread = useMemo(
    () => createThreadSelector(props.parentThreadId ?? null),
    [props.parentThreadId],
  );
  const parentThread = useStore(selectParentThread);

  return renderSubagentLabel({
    threadId: props.threadId,
    parentThreadId: props.parentThreadId,
    agentId: props.agentId,
    nickname: props.nickname,
    role: props.role,
    title: props.title,
    threads: parentThread ? [parentThread] : undefined,
    titleClassName: props.titleClassName,
    roleClassName: props.roleClassName,
  });
}
