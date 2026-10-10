// FILE: taskRowContextMenu.ts
// Purpose: The native right-click menu of a task row — which actions it offers for a plain,
//          delegated, or finished to-do. The row wires each action id to its handler.
// Layer: Tasks UI logic
// Exports: buildTaskRowContextMenu, TaskRowMenuAction

import type { ContextMenuItem } from "@synara/contracts";

import { THREAD_CONTEXT_MENU_ICONS } from "~/lib/contextMenuIcons";

export type TaskRowMenuAction =
  | "rename"
  | "open-chat"
  | "unlink-chat"
  | "delegate"
  | "toggle-done"
  | "delete";

export function buildTaskRowContextMenu(input: {
  /** Linked to a chat that still exists. */
  isDelegated: boolean;
  isDone: boolean;
  /** False while a delegation is still starting, before its link has settled. */
  canUnlink: boolean;
  /** Has a chat link at all, even to a chat that was deleted. */
  hasLink: boolean;
}): ContextMenuItem<TaskRowMenuAction>[] {
  const { isDelegated, isDone, hasLink, canUnlink } = input;
  return [
    { id: "rename", label: "Rename", icon: THREAD_CONTEXT_MENU_ICONS.rename },
    ...(isDelegated
      ? [
          { id: "open-chat" as const, label: "Open chat", separatorBefore: true },
          ...(canUnlink ? [{ id: "unlink-chat" as const, label: "Unlink chat" }] : []),
        ]
      : [
          ...(isDone
            ? []
            : [{ id: "delegate" as const, label: "Delegate…", separatorBefore: true }]),
          // A link to a chat that was deleted can still be cleared.
          ...(hasLink && canUnlink
            ? [{ id: "unlink-chat" as const, label: "Unlink chat", separatorBefore: isDone }]
            : []),
        ]),
    {
      id: "toggle-done",
      label: isDone ? "Mark as not done" : "Mark as done",
      separatorBefore: true,
    },
    {
      id: "delete",
      label: "Delete",
      icon: THREAD_CONTEXT_MENU_ICONS.delete,
      destructive: true,
      separatorBefore: true,
    },
  ];
}
