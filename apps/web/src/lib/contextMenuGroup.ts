// FILE: contextMenuGroup.ts
// Purpose: Collapses related context menu actions into one parent row that opens a submenu.
// Layer: web UI utility
// Exports: contextMenuGroup, ContextMenuGroupChild
// Why: Menus stay compact when variants of one action (handoff targets, copy variants, fork
//      targets, hub moves) share a row instead of each taking a top-level line.

import type { ContextMenuItem } from "@synara/contracts";

export interface ContextMenuGroupChild<T extends string> extends ContextMenuItem<T> {
  /** Full label used when this is the only child and the group collapses to a plain row. */
  standaloneLabel?: string;
}

/**
 * Returns zero or one top-level rows for a group of related actions: nothing when there are
 * no children, the lone child as a plain row (a one-entry submenu costs a hover for no
 * saving), otherwise a parent row with the children as its submenu.
 */
export function contextMenuGroup<T extends string>(
  parent: Omit<ContextMenuItem<T>, "children">,
  children: readonly ContextMenuGroupChild<T>[],
): ContextMenuItem<T>[] {
  const items = children.map(({ standaloneLabel: _standaloneLabel, ...item }) => item);
  if (children.length === 0) return [];
  if (children.length === 1) {
    const only = items[0]!;
    const { separatorBefore: _childSeparator, ...row } = only;
    return [
      {
        ...row,
        label: children[0]!.standaloneLabel ?? only.label,
        ...(parent.separatorBefore ? { separatorBefore: true } : {}),
      },
    ];
  }
  return [{ ...parent, children: items }];
}
