// FILE: rightDockPaneMeta.tsx
// Purpose: Shared semantic metadata (icon + label) for right-dock pane kinds.
// Layer: Chat right-dock UI primitives
// Exports: per-kind meta map, ordered add-menu kinds, and a pane label resolver.

import type { LucideIcon } from "~/lib/icons";
import {
  DiffIcon,
  GitCommitIcon,
  GlobeIcon,
  InfoIcon,
  MessageCircleIcon,
  TerminalIcon,
} from "~/lib/icons";
import {
  RIGHT_DOCK_PANE_KINDS,
  type RightDockPane,
  type RightDockPaneKind,
} from "~/rightDockStore.logic";

export interface RightDockPaneMeta {
  label: string;
  Icon: LucideIcon;
}

export const RIGHT_DOCK_PANE_META: Record<RightDockPaneKind, RightDockPaneMeta> = {
  browser: { label: "Browser", Icon: GlobeIcon },
  diff: { label: "Diff", Icon: DiffIcon },
  terminal: { label: "Terminal", Icon: TerminalIcon },
  sidechat: { label: "Side", Icon: MessageCircleIcon },
  git: { label: "Git", Icon: GitCommitIcon },
};

// Neutral fallback for any pane kind we no longer recognize (e.g. stale
// persisted state). Persisted dock state is sanitized on rehydrate, so this is
// only a defensive guard to keep a single bad pane from crashing render.
const FALLBACK_RIGHT_DOCK_PANE_META: RightDockPaneMeta = {
  label: "Panel",
  Icon: InfoIcon,
};

// Always resolve pane meta through this helper instead of indexing the map
// directly, so an unknown kind degrades gracefully rather than throwing.
export function getRightDockPaneMeta(kind: RightDockPaneKind): RightDockPaneMeta {
  return RIGHT_DOCK_PANE_META[kind] ?? FALLBACK_RIGHT_DOCK_PANE_META;
}

// Add-menu / quick triggers follow the canonical kind order from the single
// source of truth, so they stay in sync as kinds are added or removed.
export const RIGHT_DOCK_ADD_MENU_KINDS: readonly RightDockPaneKind[] = RIGHT_DOCK_PANE_KINDS;

// Resolves a tab label, preferring caller-provided per-pane overrides (e.g. the
// embedded sidechat thread title) before falling back to the kind label.
export function resolveRightDockPaneLabel(
  pane: RightDockPane,
  overrides?: Record<string, string | undefined>,
): string {
  return overrides?.[pane.id] ?? getRightDockPaneMeta(pane.kind).label;
}
