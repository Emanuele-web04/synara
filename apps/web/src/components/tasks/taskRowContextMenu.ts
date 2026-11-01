// FILE: taskRowContextMenu.ts
// Purpose: The native right-click menu of a task row — which actions it offers for a plain,
//          delegated, or finished to-do. The row wires each action id to its handler.
// Layer: Tasks UI logic
// Exports: buildTaskRowContextMenu, TaskRowMenuAction

import type { ContextMenuItem } from "@synara/contracts";
import { t } from "~/i18n";

import { THREAD_CONTEXT_MENU_ICONS } from "~/lib/contextMenuIcons";

export type TaskRowMenuAction =
  | "rename"
  | "open-chat"
  | "unlink-chat"
  | "delegate"
  | "toggle-done"
  | "delete";

export function buildTaskRowContextMenu(
  input: {
    /** Linked to a chat that still exists. */
    isDelegated: boolean;
    isDone: boolean;
    /** False while a delegation is still starting, before its link has settled. */
    canUnlink: boolean;
    /** Has a chat link at all, even to a chat that was deleted. */
    hasLink: boolean;
  },
  translate: typeof t = t,
): ContextMenuItem<TaskRowMenuAction>[] {
  const { isDelegated, isDone, hasLink, canUnlink } = input;
  return [
    { id: "rename", label: translate("workspace:rename"), icon: THREAD_CONTEXT_MENU_ICONS.rename },
    ...(isDelegated
      ? [
          { id: "open-chat" as const, label: translate("common:openChat"), separatorBefore: true },
          ...(canUnlink
            ? [{ id: "unlink-chat" as const, label: translate("common:task_unlinkChat") }]
            : []),
        ]
      : [
          ...(isDone
            ? []
            : [
                {
                  id: "delegate" as const,
                  label: translate("common:task_delegate"),
                  separatorBefore: true,
                },
              ]),
          // A link to a chat that was deleted can still be cleared.
          ...(hasLink && canUnlink
            ? [
                {
                  id: "unlink-chat" as const,
                  label: translate("common:task_unlinkChat"),
                  separatorBefore: isDone,
                },
              ]
            : []),
        ]),
    {
      id: "toggle-done",
      label: isDone ? translate("common:markAsNotDone") : translate("common:markAsDone"),
      separatorBefore: true,
    },
    {
      id: "delete",
      label: translate("computer:detail_delete"),
      icon: THREAD_CONTEXT_MENU_ICONS.delete,
      destructive: true,
      separatorBefore: true,
    },
  ];
}
