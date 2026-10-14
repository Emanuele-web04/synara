// FILE: GitHubInboxFilterBar.tsx
// Purpose: The head of the code review list: the panel title with refresh and one Filter menu,
//          the search field, the kind tabs with a count each, and, only while something is
//          filtered, a row of removable chips naming each active filter. Controlled; the page
//          owns persistence and URL overrides.
// Layer: GitHub inbox presentation
// Exports: GitHubInboxFilterBar

import type { GitHubInboxSort, ProjectId } from "@synara/contracts";
import type { ReactNode } from "react";

import type {
  GitHubInboxInvolvementFilter,
  GitHubInboxKindFilter,
  GitHubInboxStateFilter,
} from "~/appSettings";
import {
  CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
  CHAT_SURFACE_CONTROL_HOVER_CLASS_NAME,
  CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME,
} from "~/components/chat/chatHeaderControls";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "~/components/chat/ComposerPickerMenuPopup";
import { MENU_ICON_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import type { ProjectMenuPickerOption } from "~/components/ProjectMenuPicker";
import { GitHubLabelDot } from "~/components/pullRequest/GitHubLabelChips";
import { SidebarPanelTitle } from "~/components/SidebarPanelTitle";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { SearchInput } from "~/components/ui/search-input";
import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";
import {
  EllipsisIcon,
  FilterIcon,
  FoldersIcon,
  GitMergedSimpleIcon,
  IssueClosedIcon,
  IssueOpenedIcon,
  RefreshCwIcon,
  SortIcon,
  TagIcon,
  XIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  isGitHubInboxLabelSelected,
  toggleGitHubInboxLabel,
  type GitHubInboxFilters,
  type GitHubInboxKindCounts,
  type GitHubInboxLabelOption,
} from "./githubInbox.logic";

const STATE_OPTIONS: ReadonlyArray<{
  value: GitHubInboxStateFilter;
  label: string;
  icon: typeof IssueOpenedIcon;
}> = [
  { value: "open", label: "Open", icon: IssueOpenedIcon },
  // Closed includes merged pull requests; Merged shows only those.
  { value: "closed", label: "Closed", icon: IssueClosedIcon },
  { value: "merged", label: "Merged", icon: GitMergedSimpleIcon },
];

const SORT_OPTIONS: ReadonlyArray<{ value: GitHubInboxSort; label: string }> = [
  { value: "created", label: "Newest" },
  { value: "updated", label: "Recently updated" },
];

const INVOLVEMENT_OPTIONS: ReadonlyArray<{
  value: GitHubInboxInvolvementFilter;
  label: string;
}> = [
  { value: "everything", label: "Anyone" },
  { value: "involved", label: "Involving me" },
  { value: "reviewRequested", label: "Review requested" },
  { value: "authored", label: "Authored by me" },
  { value: "assigned", label: "Assigned to me" },
];

const KIND_TABS: ReadonlyArray<{
  value: GitHubInboxKindFilter;
  label: string;
  short: string;
}> = [
  { value: "all", label: "All", short: "All" },
  { value: "pullRequest", label: "Pull requests", short: "PRs" },
  { value: "issue", label: "Issues", short: "Issues" },
];
const KIND_VALUES = KIND_TABS.map((tab) => tab.value);

/** Kind as quiet text tabs, in the same fill and ink as the detail's tabs, at list size. */
function KindTabs({
  value,
  counts,
  onChange,
}: {
  value: GitHubInboxKindFilter;
  counts: GitHubInboxKindCounts | null;
  onChange: (kind: GitHubInboxKindFilter) => void;
}) {
  const radioItemProps = useRadioGroupKeyboardNav({
    values: KIND_VALUES,
    value,
    onValueChange: onChange,
  });
  return (
    <div role="radiogroup" aria-label="Kind" className="flex items-center gap-0.5">
      {KIND_TABS.map((tab) => {
        const active = tab.value === value;
        const count = counts?.[tab.value];
        return (
          <button
            key={tab.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={count === undefined ? tab.label : `${tab.label}, ${count}`}
            className={cn(
              "flex h-5 items-center gap-1 rounded-md px-1.5 text-ui-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              active
                ? CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME
                : cn(
                    CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME,
                    CHAT_SURFACE_CONTROL_HOVER_CLASS_NAME,
                  ),
            )}
            onClick={() => onChange(tab.value)}
            {...radioItemProps(tab.value)}
          >
            {tab.short}
            {count === undefined ? null : (
              <span className="text-ui-xs font-normal tabular-nums text-muted-foreground/70">
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** One active filter, named in full, with its own remove button. */
function ActiveFilterChip({
  label,
  icon,
  onRemove,
}: {
  label: string;
  icon?: ReactNode;
  onRemove: () => void;
}) {
  return (
    <Badge variant="info" className="max-w-full min-w-0 rounded-full pr-0.5 pl-1.5 font-normal">
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove filter: ${label}`}
        className="flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-info/16 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onRemove}
      >
        <XIcon aria-hidden className="size-2.5" />
      </button>
    </Badge>
  );
}

export function GitHubInboxFilterBar({
  filters,
  sort,
  onSortChange,
  query,
  kindCounts,
  projectOptions,
  labelOptions,
  refreshing,
  refreshBlockedReason,
  onQueryChange,
  onKindChange,
  onStateChange,
  onInvolvementChange,
  onProjectIdsChange,
  onLabelsChange,
  onClearFilters,
  onRefresh,
  onPasteReference,
}: {
  filters: GitHubInboxFilters;
  sort: GitHubInboxSort;
  onSortChange: (sort: GitHubInboxSort) => void;
  query: string;
  /** Rows each kind would show under the other filters; null while the list loads. */
  kindCounts: GitHubInboxKindCounts | null;
  projectOptions: ReadonlyArray<ProjectMenuPickerOption>;
  labelOptions: ReadonlyArray<GitHubInboxLabelOption>;
  refreshing: boolean;
  /** Why refresh is unavailable right now, or null when it can run. */
  refreshBlockedReason: string | null;
  onQueryChange: (query: string) => void;
  onKindChange: (kind: GitHubInboxKindFilter) => void;
  onStateChange: (state: GitHubInboxStateFilter) => void;
  onInvolvementChange: (involvement: GitHubInboxInvolvementFilter) => void;
  onProjectIdsChange: (projectIds: ProjectId[]) => void;
  onLabelsChange: (labels: string[]) => void;
  onClearFilters: () => void;
  onRefresh: () => void;
  /** Opens the item a pasted link or #number names; false leaves the paste as search text. */
  onPasteReference: (text: string) => boolean;
}) {
  const sortLabel = SORT_OPTIONS.find((option) => option.value === sort)!.label;
  const involvement =
    INVOLVEMENT_OPTIONS.find((option) => option.value === filters.involvement) ??
    INVOLVEMENT_OPTIONS[0]!;
  const toggleProject = (projectId: ProjectId) =>
    onProjectIdsChange(
      filters.projectIds.includes(projectId)
        ? filters.projectIds.filter((id) => id !== projectId)
        : [...filters.projectIds, projectId],
    );
  // What the Filter menu holds. The kind tabs and the search text show their own state, so they
  // do not light the Filter button or earn a chip.
  const menuFilterCount =
    (filters.state !== "open" ? 1 : 0) +
    (filters.involvement !== "everything" ? 1 : 0) +
    (filters.projectIds.length > 0 ? 1 : 0) +
    (filters.labels.length > 0 ? 1 : 0);
  const labelColor = (name: string) => labelOptions.find((option) => option.name === name)?.color;

  return (
    <div className="flex flex-col px-2 pt-2">
      <SidebarPanelTitle title="Code review" as="h1">
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Sort: ${sortLabel}`}
                title={`Sort: ${sortLabel}`}
              />
            }
          >
            <SortIcon className="size-3.5" />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="end" className="min-w-44">
            <MenuGroup>
              <MenuGroupLabel>Sort by</MenuGroupLabel>
              <MenuRadioGroup
                value={sort}
                onValueChange={(value) => onSortChange(value as GitHubInboxSort)}
              >
                {SORT_OPTIONS.map((option) => (
                  <MenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={menuFilterCount > 0 ? `Filter (${menuFilterCount} active)` : "Filter"}
                title="Filter"
                className={cn("relative", menuFilterCount > 0 && "text-[var(--color-text-accent)]")}
              />
            }
          >
            <FilterIcon className="size-3.5" />
            {menuFilterCount > 0 ? (
              <span
                aria-hidden
                className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-[var(--color-text-accent)]"
              />
            ) : null}
          </MenuTrigger>
          <ComposerPickerMenuPopup align="end" className="min-w-48">
            <MenuGroup>
              <MenuGroupLabel>Status</MenuGroupLabel>
              <MenuRadioGroup
                value={filters.state}
                onValueChange={(value) => onStateChange(value as GitHubInboxStateFilter)}
              >
                {STATE_OPTIONS.map((option) => (
                  <MenuRadioItem key={option.value} value={option.value}>
                    <option.icon aria-hidden className={MENU_ICON_CLASS_NAME} />
                    {option.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Involvement</MenuGroupLabel>
              <MenuRadioGroup
                value={filters.involvement}
                onValueChange={(value) =>
                  onInvolvementChange(value as GitHubInboxInvolvementFilter)
                }
              >
                {INVOLVEMENT_OPTIONS.map((option) => (
                  <MenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuSub>
              <MenuSubTrigger>
                <FoldersIcon aria-hidden className={MENU_ICON_CLASS_NAME} />
                Projects
                {filters.projectIds.length > 0 ? (
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {filters.projectIds.length}
                  </span>
                ) : null}
              </MenuSubTrigger>
              <ComposerPickerMenuSubPopup className="max-h-80 min-w-48 overflow-y-auto">
                {projectOptions.length === 0 ? (
                  <MenuItem disabled>No projects</MenuItem>
                ) : (
                  projectOptions.map((option) => (
                    <MenuCheckboxItem
                      key={option.id}
                      checked={filters.projectIds.includes(option.id)}
                      onCheckedChange={() => toggleProject(option.id)}
                    >
                      <span className="min-w-0 truncate">{option.name}</span>
                    </MenuCheckboxItem>
                  ))
                )}
              </ComposerPickerMenuSubPopup>
            </MenuSub>
            <MenuSub>
              <MenuSubTrigger>
                <TagIcon aria-hidden className={MENU_ICON_CLASS_NAME} />
                Labels
                {filters.labels.length > 0 ? (
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {filters.labels.length}
                  </span>
                ) : null}
              </MenuSubTrigger>
              <ComposerPickerMenuSubPopup className="max-h-80 min-w-52 overflow-y-auto">
                {labelOptions.length === 0 ? (
                  <MenuItem disabled>No labels in this view</MenuItem>
                ) : (
                  labelOptions.map((option) => (
                    <MenuCheckboxItem
                      key={option.name}
                      checked={isGitHubInboxLabelSelected(filters.labels, option.name)}
                      onCheckedChange={() =>
                        onLabelsChange(toggleGitHubInboxLabel(filters.labels, option.name))
                      }
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <GitHubLabelDot color={option.color} className="size-2" />
                        <span className="min-w-0 truncate">{option.name}</span>
                        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                          {option.count}
                        </span>
                      </span>
                    </MenuCheckboxItem>
                  ))
                )}
              </ComposerPickerMenuSubPopup>
            </MenuSub>
            {menuFilterCount > 0 ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={onClearFilters}>Clear filters</MenuItem>
              </>
            ) : null}
          </ComposerPickerMenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="More code review actions"
                title="More"
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="end" className="min-w-44">
            <MenuItem
              disabled={refreshBlockedReason !== null}
              title={refreshBlockedReason ?? undefined}
              onClick={onRefresh}
            >
              <RefreshCwIcon
                aria-hidden
                className={cn(MENU_ICON_CLASS_NAME, refreshing && "animate-spin")}
              />
              {refreshing ? "Refreshing…" : "Refresh"}
            </MenuItem>
            {menuFilterCount > 0 ? (
              <MenuItem onClick={onClearFilters}>Clear filters</MenuItem>
            ) : null}
          </ComposerPickerMenuPopup>
        </Menu>
      </SidebarPanelTitle>
      <div className="flex flex-col gap-2.5 px-4 pt-1 pb-2">
        <SearchInput
          placeholder="Search or paste a PR link"
          aria-label="Search pull requests and issues"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onPaste={(event) => {
            // A pasted link or #number that names one loaded item opens it instead of searching.
            if (onPasteReference(event.clipboardData.getData("text"))) event.preventDefault();
          }}
        />
        <KindTabs value={filters.kind} counts={kindCounts} onChange={onKindChange} />
        {menuFilterCount > 0 ? (
          <div className="flex flex-wrap items-center gap-1" aria-label="Active filters">
            {filters.state !== "open" ? (
              <ActiveFilterChip
                label={filters.state === "merged" ? "Merged" : "Closed"}
                onRemove={() => onStateChange("open")}
              />
            ) : null}
            {filters.involvement !== "everything" ? (
              <ActiveFilterChip
                label={involvement.label}
                onRemove={() => onInvolvementChange("everything")}
              />
            ) : null}
            {filters.projectIds.map((projectId) => (
              <ActiveFilterChip
                key={projectId}
                label={projectOptions.find((option) => option.id === projectId)?.name ?? "Project"}
                onRemove={() => toggleProject(projectId)}
              />
            ))}
            {filters.labels.map((label) => (
              <ActiveFilterChip
                key={label}
                label={label}
                icon={<GitHubLabelDot color={labelColor(label)} className="size-2" />}
                onRemove={() => onLabelsChange(toggleGitHubInboxLabel(filters.labels, label))}
              />
            ))}
            <button
              type="button"
              className="h-5 rounded-full px-1.5 text-ui-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={onClearFilters}
            >
              Clear
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
