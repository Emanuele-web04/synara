// FILE: PullRequestListFilters.tsx
// Purpose: The pull requests list's project filter popover behind the header's filter icon.
//          The involvement and state tabs use the shared FilterPillGroup.
// Layer: Pull request presentation
// Exports: PullRequestProjectFilterPopover

import type { ProjectId } from "@synara/contracts";
import { useState } from "react";

import { IconButton } from "~/components/ui/icon-button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { CheckIcon, FilterIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { PR_BODY_TEXT_CLASS_NAME, PR_FINE_TEXT_CLASS_NAME } from "./pullRequestText";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "~/surfaceStyles";

/** One selectable project in the filter popover — full-width row with a trailing check. */
const PROJECT_FILTER_OPTION_CLASS_NAME = cn(
  PR_BODY_TEXT_CLASS_NAME,
  "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left",
  ELEVATED_HOVER_SURFACE_CLASS_NAME,
);

export function PullRequestProjectFilterPopover({
  projects,
  value,
  onChange,
}: {
  projects: ReadonlyArray<readonly [ProjectId, string]>;
  value: ProjectId | undefined;
  onChange: (projectId: ProjectId | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = value !== undefined;
  const selectedProjectName = value
    ? projects.find(([projectId]) => projectId === value)?.[1]
    : undefined;
  const triggerLabel = `Filter pull requests by project: ${selectedProjectName ?? "All projects"}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <IconButton
            label={triggerLabel}
            tooltip="Filter by project"
            aria-pressed={active}
            className={cn("relative", active && "text-foreground")}
          >
            <FilterIcon className="size-4" />
            {active ? (
              <span
                aria-hidden="true"
                className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary"
              />
            ) : null}
          </IconButton>
        }
      />
      <PopoverPopup align="end" className="w-64 p-1">
        <div className={cn(PR_FINE_TEXT_CLASS_NAME, "px-2 py-1 font-medium text-muted-foreground")}>
          Project
        </div>
        <div className="max-h-72 overflow-y-auto">
          <button
            type="button"
            aria-pressed={value === undefined}
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
            className={cn(
              PROJECT_FILTER_OPTION_CLASS_NAME,
              value === undefined && "text-foreground",
            )}
          >
            <span className="min-w-0 truncate">All projects</span>
            {value === undefined ? <CheckIcon aria-hidden className="size-3.5 shrink-0" /> : null}
          </button>
          {projects.map(([id, title]) => (
            <button
              key={id}
              type="button"
              aria-pressed={value === id}
              onClick={() => {
                onChange(id);
                setOpen(false);
              }}
              className={cn(PROJECT_FILTER_OPTION_CLASS_NAME, value === id && "text-foreground")}
            >
              <span className="min-w-0 truncate">{title}</span>
              {value === id ? <CheckIcon aria-hidden className="size-3.5 shrink-0" /> : null}
            </button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
