// FILE: PullRequestList.tsx
// Purpose: The GitHub inbox list body — Pinned, then All (or the involvement sections), built
//          from the sidebar's own list sections: each shows its first page of rows with "Show
//          more" / "Show less". Pinned and All stay open; involvement sections fold behind their
//          label. All shows its label only under Pinned, so an unpinned list reads like GitHub's. Rows use repository + number identity because the
//          list has one row per remote item; selection still retains project context for the
//          detail.
// Layer: Pull request presentation
// Exports: PullRequestList

import type { GitHubInboxItem, GitHubInboxSort, ProjectId } from "@synara/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { resolveSidebarThreadListPaging } from "~/components/Sidebar.logic";
import {
  SidebarCollapsibleSection,
  SidebarSectionLabel,
  SidebarShowMoreRow,
} from "~/components/SidebarListSection";
import {
  pullRequestListEntryKey,
  type PullRequestListGroup,
  type PullRequestListGroupKey,
} from "./pullRequestList.logic";
import { PullRequestRow } from "./PullRequestRow";

/** Rows a section shows first, and how many each "Show more" adds. */
const SECTION_PAGE_SIZE = 10;

// The list bleeds past the column padding by the rows' own inner padding, so a row's hover
// surface keeps a halo while its title sits on the filter bar's vertical, and nothing (the
// disclosure region clips its content) cuts the halo or a focus ring off. Section labels and the
// paging row pad by the same amount to stay on that vertical.
const LIST_BLEED_CLASS_NAME = "-mx-3";
const LIST_INSET_CLASS_NAME = "px-3";

export const PullRequestList = function PullRequestList({
  groups,
  sort,
  isSelected,
  isSectionOpen,
  onToggleSection,
  showProjectTitle: showProjectTitleProp,
  projectIconFor,
  onSelect,
  onTogglePinned,
}: {
  groups: ReadonlyArray<PullRequestListGroup>;
  sort: GitHubInboxSort;
  isSelected: (entry: GitHubInboxItem) => boolean;
  /** Whether a collapsible section is expanded. Pinned and All are always open. */
  isSectionOpen: (key: PullRequestListGroupKey) => boolean;
  onToggleSection: (key: PullRequestListGroupKey) => void;
  showProjectTitle?: boolean;
  projectIconFor?: (projectId: ProjectId) => ReactNode;
  onSelect: (entry: GitHubInboxItem) => void;
  onTogglePinned: (entry: GitHubInboxItem) => void;
}) {
  const showProjectTitle = showProjectTitleProp ?? false;
  // Extra pages each section has revealed. Not persisted: a fresh visit starts at the first page.
  const [extraPages, setExtraPages] = useState<Partial<Record<PullRequestListGroupKey, number>>>(
    {},
  );
  // A pin moves the row into (or out of) another section, which remounts it and drops focus.
  // Hand focus to the same row's pin control once the move has rendered.
  const pinFocusKey = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = pinFocusKey.current;
    if (key === null) return;
    pinFocusKey.current = null;
    const pin = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>("[data-pull-request-row]") ?? [],
    )
      .find((row) => `${row.dataset.repository}#${row.dataset.pullRequestNumber}` === key)
      ?.parentElement?.querySelector<HTMLElement>("button[aria-pressed]");
    pin?.focus();
  });
  const renderEntry = (entry: GitHubInboxItem) => (
    <PullRequestRow
      key={pullRequestListEntryKey(entry)}
      entry={entry}
      sort={sort}
      showProjectTitle={showProjectTitle}
      {...(showProjectTitle && projectIconFor
        ? { projectIcon: projectIconFor(entry.projectId) }
        : {})}
      selected={isSelected(entry)}
      onClick={onSelect}
      onTogglePinned={(current) => {
        pinFocusKey.current = `${current.repository}#${current.number}`;
        onTogglePinned(current);
      }}
    />
  );
  return (
    <div ref={containerRef} className={`flex flex-col gap-3 ${LIST_BLEED_CLASS_NAME}`}>
      {groups.map((group) => {
        const paging = resolveSidebarThreadListPaging({
          totalCount: group.entries.length,
          baseLimit: SECTION_PAGE_SIZE,
          pageSize: SECTION_PAGE_SIZE,
          requestedExtraPages: extraPages[group.key] ?? 0,
        });
        const setPages = (pages: number) =>
          setExtraPages((current) => ({ ...current, [group.key]: Math.max(0, pages) }));
        const rows = (
          <>
            {group.entries.slice(0, paging.previewLimit).map(renderEntry)}
            <SidebarShowMoreRow
              canShowMore={paging.canShowMore}
              canShowLess={paging.canShowLess}
              onShowMore={() => setPages(paging.effectiveExtraPages + 1)}
              onShowLess={() => setPages(paging.effectiveExtraPages - 1)}
              className={LIST_INSET_CLASS_NAME}
            />
          </>
        );
        return (
          <section key={group.key} aria-label={group.label} data-inbox-section={group.key}>
            {group.key === "pinned" || group.key === "all" ? (
              <>
                {group.key === "pinned" || groups.length > 1 ? (
                  <SidebarSectionLabel
                    as="h2"
                    label={group.label}
                    className={LIST_INSET_CLASS_NAME}
                  />
                ) : null}
                <div className="flex flex-col gap-0.5">{rows}</div>
              </>
            ) : (
              <SidebarCollapsibleSection
                label={group.label}
                open={isSectionOpen(group.key)}
                onToggle={() => onToggleSection(group.key)}
                headerClassName={LIST_INSET_CLASS_NAME}
                headingLevel={2}
              >
                {rows}
              </SidebarCollapsibleSection>
            )}
          </section>
        );
      })}
    </div>
  );
};
