// FILE: rightDockPaneMeta.tsx
// Purpose: Shared semantic metadata (icon + label) for right-dock pane kinds.
// Layer: Chat right-dock UI primitives
// Exports: per-kind meta map, ordered add-menu kinds, and a pane label resolver.

import type { LucideIcon } from "~/lib/icons";
import { DiffIcon, GitCommitIcon, GlobeIcon, MessageCircleIcon, TerminalIcon } from "~/lib/icons";
import type { RightDockPane, RightDockPaneKind } from "~/rightDockStore.logic";

export interface RightDockPaneMeta {
  label: string;
  Icon: LucideIcon;
}

export const RIGHT_DOCK_PANE_META: Record<RightDockPaneKind, RightDockPaneMeta> = {
  browser: { label: "Browser", Icon: GlobeIcon },
  diff: { label: "Diff", Icon: DiffIcon },
  terminal: { label: "Terminal", Icon: TerminalIcon },
  sidechat: { label: "Side chat", Icon: MessageCircleIcon },
  git: { label: "Git", Icon: GitCommitIcon },
};

// Order the add-menu / quick triggers consistently across the dock surfaces.
export const RIGHT_DOCK_ADD_MENU_KINDS: readonly RightDockPaneKind[] = [
  "browser",
  "diff",
  "terminal",
  "sidechat",
  "git",
];

// Resolves a tab label, preferring caller-provided per-pane overrides (e.g. the
// embedded sidechat thread title) before falling back to the kind label.
export function resolveRightDockPaneLabel(
  pane: RightDockPane,
  overrides?: Record<string, string | undefined>,
): string {
  return overrides?.[pane.id] ?? RIGHT_DOCK_PANE_META[pane.kind].label;
}
