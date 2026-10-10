// FILE: useTaskDelegateChat.ts
// Purpose: The "Chat" choice of the Tasks delegate form — a new chat, or one of the recent
//          chats that can still take this to-do.
// Layer: Tasks UI hook
// Exports: useTaskDelegateChat, TaskDelegateChatState

import type { ThreadId, Todo } from "@synara/contracts";
import { useMemo, useState } from "react";

import { useStore } from "../../store";
import { useTodoList } from "./useTodos";

const RECENT_CHAT_LIMIT = 12;

export function useTaskDelegateChat(todoId: Todo["id"]) {
  const projects = useStore((state) => state.projects);
  const threadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
  const { todos } = useTodoList();
  // A chat already working on another open to-do can't take this one too (the server
  // refuses it as well): both would read that chat's turns as theirs.
  const chatIdsOwnedElsewhere = useMemo(
    () =>
      new Set(
        todos.flatMap((other) =>
          other.id !== todoId && other.threadId !== null && other.completedAt === null
            ? [other.threadId]
            : [],
        ),
      ),
    [todoId, todos],
  );
  const recentChats = useMemo(
    () =>
      Object.values(threadSummaryById)
        .filter(
          (thread) =>
            !thread.archivedAt &&
            !thread.parentThreadId &&
            !thread.sidechatSourceThreadId &&
            !chatIdsOwnedElsewhere.has(thread.id),
        )
        .toSorted((left, right) =>
          (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt),
        )
        .slice(0, RECENT_CHAT_LIMIT),
    [chatIdsOwnedElsewhere, threadSummaryById],
  );
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );
  const [existingChatId, setExistingChatId] = useState<ThreadId | null>(null);
  const existingChat = existingChatId ? (threadSummaryById[existingChatId] ?? null) : null;

  return { existingChat, existingChatId, setExistingChatId, recentChats, projectNameById };
}

export type TaskDelegateChatState = ReturnType<typeof useTaskDelegateChat>;
