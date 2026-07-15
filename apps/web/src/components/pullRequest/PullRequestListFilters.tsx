// FILE: PullRequestListFilters.tsx
// Purpose: The pull requests list's filter controls — the plain text pill group used for the
//          involvement and state tabs (chip background on the active option only), and the
//          project filter popover behind the header's filter icon.
// Layer: Pull request presentation
// Exports: PullRequestFilterPillGroup, PullRequestProjectFilterPopover

import type { ProjectId } from "@synara/contracts";
import { useState } from "react";

import { CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME } from "~/components/chat/chatHeaderControls";
import { IconButton } from "~/components/ui/icon-button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { CheckIcon, FilterIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  PR_BODY_TEXT_CLASS_NAME,
  PR_FINE_TEXT_CLASS_NAME,
  PR_META_TEXT_CLASS_NAME,
} from "./pullRequestText";

export function PullRequestFilterPillGroup<T extends string>({
  value,
  options,
  onChange,
  onIntent,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  onIntent?: (value: T) => void;
}) {
  return (
    // Sized off the shared UI font var so the pills track the user's font-size setting like
    // every Button-based control.
    <div className={cn(PR_META_TEXT_CLASS_NAME, "flex items-center gap-1")}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onFocus={() => onIntent?.(option.value)}
          onPointerEnter={() => onIntent?.(option.value)}
          onClick={() => onChange(option.value)}
          // Active uses the shared control-active token (real contrast in both modes) — the
          // elevated-secondary tint is a 2–4% hover wash and disappears on dark surfaces.
          className={cn(
            "rounded-md px-2.5 py-1 transition-colors",
            option.value === value
              ? CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

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
              PR_BODY_TEXT_CLASS_NAME,
              "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-background-elevated-secondary)]",
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
              className={cn(
                PR_BODY_TEXT_CLASS_NAME,
                "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-background-elevated-secondary)]",
                value === id && "text-foreground",
              )}
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
