import type { ReactNode } from "react";

import { basenameOfPath } from "~/file-icons";
import type { LucideIcon } from "~/lib/icons";
import {
  DeviceMobileIcon,
  DiffIcon,
  FileIcon,
  FoldersIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  GlobeIcon,
  InfoIcon,
  SidechatIcon,
  TerminalIcon,
} from "~/lib/icons";
import { type RightDockPane, type RightDockPaneKind } from "~/rightDockStore.logic";
import { CHAT_SURFACE_CHIP_ICON_CLASS_NAME, SurfaceChipIcon } from "./chatHeaderControls";
import { FileEntryIcon } from "./FileEntryIcon";
import { pullRequestPaneTabLabel } from "../pullRequest/pullRequestDetail.logic";

export interface RightDockPaneMeta {
  label: string;
  Icon: LucideIcon;
}

export interface RightDockLauncherItem extends RightDockPaneMeta {
  kind: RightDockPaneKind;
}

export const RIGHT_DOCK_PANE_META: Record<RightDockPaneKind, RightDockPaneMeta> = {
  browser: { label: "Browser", Icon: GlobeIcon },
  // contracts stay platform-neutral ("device") so Android emulators can plug in later, but the only backend today is iOS Simulator
  device: { label: "iOS Simulator", Icon: DeviceMobileIcon },
  diff: { label: "Diff", Icon: DiffIcon },
  explorer: { label: "Explorer", Icon: FoldersIcon },
  file: { label: "File", Icon: FileIcon },
  terminal: { label: "Terminal", Icon: TerminalIcon },
  sidechat: { label: "Side chats", Icon: SidechatIcon },
  git: { label: "Git", Icon: GitCommitIcon },
  pullRequest: { label: "Pull request", Icon: GitPullRequestIcon },
};

// neutral fallback for unrecognized pane kinds (stale persisted state); defensive guard so one bad pane can't crash render
const FALLBACK_RIGHT_DOCK_PANE_META: RightDockPaneMeta = {
  label: "Panel",
  Icon: InfoIcon,
};

// always resolve through this helper instead of indexing the map directly, so unknown kinds degrade gracefully
export function getRightDockPaneMeta(kind: RightDockPaneKind): RightDockPaneMeta {
  return RIGHT_DOCK_PANE_META[kind] ?? FALLBACK_RIGHT_DOCK_PANE_META;
}

// empty-dock launchers prioritize everyday tools; Review needs changes, Git needs repo discovery, Explorer needs a workspace
const RIGHT_DOCK_LAUNCHER_ORDER: readonly RightDockPaneKind[] = [
  "diff",
  "terminal",
  "browser",
  "explorer",
  "sidechat",
  "device",
  "git",
];

const RIGHT_DOCK_LAUNCHER_LABELS: Partial<Record<RightDockPaneKind, string>> = {
  diff: "Review",
  explorer: "Files",
  sidechat: "Side chats",
  git: "Source control",
};

export function resolveRightDockLauncherItems(input: {
  hasWorkspace: boolean;
  hasGitRepository: boolean;
  hasReview: boolean;
  /**
   * Simulators need a macOS server with Xcode. Off macOS the entry is hidden
   * outright rather than shown disabled: there is nothing the user could do
   * from this machine to make it work.
   */
  hasDeviceSupport?: boolean;
}): readonly RightDockLauncherItem[] {
  return RIGHT_DOCK_LAUNCHER_ORDER.flatMap((kind) => {
    if (kind === "diff" && !input.hasReview) {
      return [];
    }
    if (kind === "git" && !input.hasGitRepository) {
      return [];
    }
    if (kind === "explorer" && !input.hasWorkspace) {
      return [];
    }
    if (kind === "device" && input.hasDeviceSupport !== true) {
      return [];
    }
    const meta = getRightDockPaneMeta(kind);
    return [
      {
        kind,
        Icon: meta.Icon,
        label: RIGHT_DOCK_LAUNCHER_LABELS[kind] ?? meta.label,
      },
    ];
  });
}

// tab label prefers caller-provided per-pane overrides (e.g. embedded sidechat title) before the kind label
export function resolveRightDockPaneLabel(
  pane: RightDockPane,
  overrides?: Record<string, string | undefined>,
): string {
  return overrides?.[pane.id] ?? getRightDockPaneMeta(pane.kind).label;
}

export function buildRightDockPaneLabelOverrides(
  panes: readonly RightDockPane[],
  threadSummaries: readonly { id: string; title: string }[],
): Record<string, string | undefined> | undefined {
  const sidechatTitleByThreadId = new Map(
    threadSummaries.map((thread) => [thread.id, thread.title] as const),
  );
  const overrides: Record<string, string | undefined> = {};

  for (const pane of panes) {
    if (pane.kind === "file" && pane.filePath) {
      overrides[pane.id] = basenameOfPath(pane.filePath);
    } else if (pane.kind === "pullRequest" && pane.pullRequestNumber !== null) {
      overrides[pane.id] = pullRequestPaneTabLabel(pane.pullRequestNumber);
    } else if (pane.kind === "sidechat" && pane.threadId) {
      const title = sidechatTitleByThreadId.get(pane.threadId)?.trim();
      if (title) {
        overrides[pane.id] = title;
      }
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

// file panes show the per-file-type icon; the glyph inherits the tab's muted foreground instead of its extension color so dock tabs read like changed-file rows
export function resolveRightDockPaneIcon(pane: RightDockPane): ReactNode {
  if (pane.kind === "file" && pane.filePath) {
    return (
      <FileEntryIcon
        pathValue={pane.filePath}
        kind="file"
        colorMode="inherit"
        className={CHAT_SURFACE_CHIP_ICON_CLASS_NAME}
      />
    );
  }
  return <SurfaceChipIcon icon={getRightDockPaneMeta(pane.kind).Icon} />;
}
