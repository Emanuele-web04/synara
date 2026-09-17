// FILE: ThreadHoverCardContent.tsx
// Purpose: Rich hover-card body shown when hovering a sidebar thread/chat row —
//          the title with a relative time on the header line, then project,
//          source folder, git branch, worktree identity, pull request, and the chat's current
//          model rows when available.
// Layer: Sidebar UI component
// Exports: ThreadHoverCardContent
// Why: Shared by both the pinned and the nested thread-row tooltips so the two
//      surfaces cannot drift apart.

import type { OrchestrationThreadPullRequest } from "@synara/contracts";
import type { MouseEvent, ReactNode } from "react";

import { FastModeIcon, GitBranchIcon, WorktreeIcon } from "~/lib/icons";
import type { ThreadModelSummary } from "~/lib/threadModelSummary";
import { FolderClosed } from "./FolderClosed";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { ProviderIcon } from "./ProviderIcon";
import {
  PR_STATE_PRESENTATION_ICONS,
  resolvePrStatePresentation,
} from "./pullRequest/pullRequestStatePresentation";
import type { ThreadStatusPill } from "./Sidebar.logic";
import { SidebarStatusTrailingGlyph } from "./SidebarStatusTrailingGlyph";
import {
  SIDEBAR_HOVER_CARD_CONTAINER_PADDING_CLASS_NAME,
  SIDEBAR_HOVER_CARD_ROW_CLASS_NAME,
} from "./sidebarHoverCardStyles";

export type ThreadHoverCardContentProps = {
  title: string;
  /** Pre-formatted relative time (e.g. "2h"); omitted when unavailable. */
  timeLabel: string | null;
  projectName: string | null;
  /** Project cwd, used to render the matching folder/favicon glyph. */
  projectCwd: string | null;
  /** Underlying project folder/repo name, shown for worktree-backed chats. */
  sourceProjectName: string | null;
  branch: string | null;
  /** Last path segment of the associated worktree path. */
  worktreeName: string | null;
  /** The same resolved PR shown on the thread row. */
  pullRequest: OrchestrationThreadPullRequest | null;
  onOpenPullRequest: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  /** Provider/model/effort currently selected for this chat. */
  model: ThreadModelSummary | null;
  /** Current live/actionable state, shown as text so compact row glyphs stay discoverable. */
  status: ThreadStatusPill | null;
};

const META_ROW_CLASS_NAME = `${SIDEBAR_HOVER_CARD_ROW_CLASS_NAME} text-foreground/80`;
const META_ICON_CLASS_NAME = "size-3.5 shrink-0 text-muted-foreground/75";

function MetaRow({ icon, children }: { icon: ReactNode; children: string }) {
  return (
    <span className={META_ROW_CLASS_NAME}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

// Model row: provider glyph, model name, then the reasoning/effort label so the
// line reads like the composer's model trigger.
function ModelRow({ model }: { model: ThreadModelSummary }) {
  return (
    <span className={META_ROW_CLASS_NAME}>
      <ProviderIcon provider={model.provider} className={META_ICON_CLASS_NAME} />
      <span className="min-w-0 truncate">{model.modelLabel}</span>
      {model.fastMode ? (
        <FastModeIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/75" />
      ) : null}
      {model.statusLabel ? (
        <span className="shrink-0 text-muted-foreground/70">{model.statusLabel}</span>
      ) : null}
    </span>
  );
}

export function ThreadHoverCardContent({
  title,
  timeLabel,
  projectName,
  projectCwd,
  sourceProjectName,
  branch,
  worktreeName,
  pullRequest,
  onOpenPullRequest,
  model,
  status,
}: ThreadHoverCardContentProps) {
  const hasMeta =
    Boolean(projectName) ||
    Boolean(sourceProjectName) ||
    Boolean(branch) ||
    Boolean(worktreeName) ||
    Boolean(pullRequest) ||
    Boolean(model) ||
    Boolean(status);

  return (
    <div
      className={`flex w-full flex-col gap-0 ${SIDEBAR_HOVER_CARD_CONTAINER_PADDING_CLASS_NAME}`}
    >
      <div className={SIDEBAR_HOVER_CARD_ROW_CLASS_NAME}>
        <span className="min-w-0 flex-1 whitespace-normal font-medium leading-tight text-foreground">
          {title}
        </span>
        {timeLabel ? (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/55">
            {timeLabel}
          </span>
        ) : null}
      </div>
      {hasMeta ? (
        <div className="flex flex-col gap-0">
          {status ? (
            <MetaRow
              icon={
                <span
                  aria-hidden="true"
                  className="inline-flex size-3.5 items-center justify-center"
                >
                  <SidebarStatusTrailingGlyph status={status} />
                </span>
              }
            >
              {status.label}
            </MetaRow>
          ) : null}
          {projectName ? (
            <MetaRow
              icon={
                projectCwd ? (
                  <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/75">
                    <ProjectSidebarIcon
                      cwd={projectCwd}
                      expanded={false}
                      glyphClassName="size-3.5"
                    />
                  </span>
                ) : (
                  <FolderClosed className={META_ICON_CLASS_NAME} aria-hidden />
                )
              }
            >
              {projectName}
            </MetaRow>
          ) : null}
          {sourceProjectName ? (
            <MetaRow icon={<FolderClosed className={META_ICON_CLASS_NAME} aria-hidden />}>
              {sourceProjectName}
            </MetaRow>
          ) : null}
          {branch ? (
            <MetaRow icon={<GitBranchIcon className={META_ICON_CLASS_NAME} aria-hidden />}>
              {branch}
            </MetaRow>
          ) : null}
          {worktreeName ? (
            <MetaRow icon={<WorktreeIcon className={META_ICON_CLASS_NAME} aria-hidden />}>
              {worktreeName}
            </MetaRow>
          ) : null}
          {pullRequest ? <PullRequestRow pr={pullRequest} onOpen={onOpenPullRequest} /> : null}
          {model ? <ModelRow model={model} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function PullRequestRow({
  pr,
  onOpen,
}: {
  pr: OrchestrationThreadPullRequest;
  onOpen: ThreadHoverCardContentProps["onOpenPullRequest"];
}) {
  const presentation = resolvePrStatePresentation(pr);
  const PrIcon = PR_STATE_PRESENTATION_ICONS[presentation.iconKind];

  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`#${pr.number} ${presentation.label}: ${pr.title}`}
      className={`${META_ROW_CLASS_NAME} cursor-pointer outline-hidden hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring`}
      onClick={(event) => onOpen(event, pr.url)}
      onAuxClick={(event) => {
        if (event.button === 1) onOpen(event, pr.url);
      }}
    >
      <PrIcon aria-hidden className={`size-3.5 shrink-0 ${presentation.colorClass}`} />
      <span className="min-w-0 truncate">
        <span className={presentation.colorClass}>#{pr.number}</span> {pr.title}
      </span>
    </a>
  );
}
