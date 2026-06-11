// FILE: Sidebar.threadRowMeta.tsx
// Purpose: Builds the trailing meta-chip stack (handoff/fork/sidechat/worktree) for sidebar thread rows.
// Layer: Sidebar presentation (pure builder + chip type).
// Exports: ThreadMetaChip, resolveThreadRowMetaChips

import type { ReactNode } from "react";
import { FiGitBranch } from "react-icons/fi";
import { GoRepoForked } from "react-icons/go";
import { DisposableThreadIcon } from "~/lib/icons";
import type { Thread } from "../types";
import { resolveThreadHandoffBadgeLabel } from "../lib/threadHandoff";
import { WorktreeBadgeGlyph } from "./Sidebar.icons";
import { SidebarGlyph } from "./sidebarGlyphs";
import { resolveWorktreeBadgeLabel } from "./Sidebar.logic";

export type ThreadMetaChip = {
  id: "handoff" | "fork" | "sidechat" | "worktree";
  tooltip: string;
  icon: ReactNode;
};

/**
 * Back-to-front order: first = behind, last = in front.
 * Priority lowest -> highest: handoff -> fork/sidechat -> worktree.
 */
export function resolveThreadRowMetaChips(input: {
  thread: Pick<
    Thread,
    "forkSourceThreadId" | "sidechatSourceThreadId" | "envMode" | "worktreePath" | "handoff"
  >;
  includeHandoffBadge: boolean;
  /**
   * When the leading provider avatar already renders the source → target handoff
   * pair, the trailing handoff chip is a redundant double icon and is dropped.
   */
  handoffShownInAvatar?: boolean;
}): ThreadMetaChip[] {
  const chips: ThreadMetaChip[] = [];

  const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(input.thread);
  if (input.includeHandoffBadge && !input.handoffShownInAvatar && handoffBadgeLabel) {
    chips.push({
      id: "handoff",
      tooltip: handoffBadgeLabel,
      icon: <SidebarGlyph icon={FiGitBranch} variant="meta" className="text-muted-foreground/70" />,
    });
  }

  if (input.thread.forkSourceThreadId) {
    chips.push({
      id: "fork",
      tooltip: "Forked thread",
      icon: (
        <SidebarGlyph
          icon={GoRepoForked}
          variant="meta"
          className="text-emerald-600 dark:text-emerald-300/90"
        />
      ),
    });
  }

  if (input.thread.sidechatSourceThreadId) {
    chips.push({
      id: "sidechat",
      tooltip: "Sidechat",
      icon: <DisposableThreadIcon className="text-sky-600 dark:text-sky-300/90" />,
    });
  }

  const worktreeBadgeLabel = resolveWorktreeBadgeLabel(input.thread);
  if (worktreeBadgeLabel) {
    chips.push({
      id: "worktree",
      tooltip: worktreeBadgeLabel,
      icon: <WorktreeBadgeGlyph className="text-muted-foreground/70" />,
    });
  }

  return chips;
}
