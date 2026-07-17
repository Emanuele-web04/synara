// FILE: SpaceProjectPickerDialog.tsx
// Purpose: Searchable bulk assignment flow for populating an empty Space.

import type { ProjectId } from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";

import type { Project, Space } from "~/types";
import { CheckIcon } from "~/lib/icons";
import { groupItemsBySpace, spaceDisplayName } from "~/lib/spaceGrouping";
import { isOrdinarySpaceProject } from "~/lib/spaces";
import { cn } from "~/lib/utils";
import { useSpacesUiStore } from "~/spacesUiStore";
import { useWorkspaceStore } from "~/workspaceStore";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { SpaceIcon } from "./SpaceIcon";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { SearchInput } from "./ui/search-input";

export function SpaceProjectPickerDialog(props: {
  open: boolean;
  targetSpace: Space | null;
  projects: ReadonlyArray<Project>;
  spaces: ReadonlyArray<Space>;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    projectIds: ReadonlyArray<ProjectId>,
  ) => Promise<ReadonlyArray<ProjectId> | void> | ReadonlyArray<ProjectId> | void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<ProjectId>>(() => new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspaceStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspaceStore((state) => state.studioWorkspaceRoot);

  useEffect(() => {
    if (!props.open) return;
    setQuery("");
    setSelectedIds(new Set());
    setSubmitting(false);
    setError(null);
  }, [props.open, props.targetSpace?.id]);

  const targetSpaceId = props.targetSpace?.id ?? null;
  /**
   * Everything that could move — i.e. every ordinary project not already in the target.
   * Membership goes through `isOrdinarySpaceProject` (the one rule for what a Space can
   * hold) rather than a local kind check, so containers stay out regardless of caller.
   */
  const movableProjects = useMemo(
    () =>
      props.projects.filter(
        (project) =>
          isOrdinarySpaceProject(project, { homeDir, chatWorkspaceRoot, studioWorkspaceRoot }) &&
          (project.spaceId ?? null) !== targetSpaceId,
      ),
    [chatWorkspaceRoot, homeDir, props.projects, studioWorkspaceRoot, targetSpaceId],
  );
  const candidates = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return movableProjects
      .filter(
        (project) =>
          normalizedQuery.length === 0 ||
          project.name.toLocaleLowerCase().includes(normalizedQuery) ||
          project.cwd.toLocaleLowerCase().includes(normalizedQuery) ||
          spaceDisplayName(project.spaceId, props.spaces)
            .toLocaleLowerCase()
            .includes(normalizedQuery),
      )
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }, [movableProjects, props.spaces, query]);
  const candidateGroups = useMemo(
    () =>
      groupItemsBySpace({
        items: candidates,
        spaces: props.spaces,
        activeSpaceId,
        spaceIdOf: (project) => project.spaceId ?? null,
      }),
    [activeSpaceId, candidates, props.spaces],
  );

  const submit = async () => {
    if (selectedIds.size === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const submittedCount = selectedIds.size;
      const failedProjectIds = (await props.onSubmit([...selectedIds])) ?? [];
      if (failedProjectIds.length > 0) {
        setSelectedIds(new Set(failedProjectIds));
        setError(
          `${submittedCount - failedProjectIds.length} moved; ${failedProjectIds.length} could not be moved. Try again.`,
        );
        setSubmitting(false);
        return;
      }
      props.onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to move the selected projects.");
      setSubmitting(false);
    }
  };

  // Three different nothings: no projects at all, none left to move, none matching the search.
  const emptyMessage =
    props.projects.length === 0
      ? "No projects yet."
      : movableProjects.length === 0
        ? `Every project is already in ${props.targetSpace?.name ?? "this space"}.`
        : "No matching projects.";

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup surface="solid" className="max-w-md">
        <DialogHeader>
          <DialogTitle>Move projects to {props.targetSpace?.name ?? "space"}</DialogTitle>
          <DialogDescription>
            Choose existing projects. Their chats and pinned state move with them.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <SearchInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects"
            aria-label="Search projects"
          />
          <div className="max-h-72 space-y-3 overflow-y-auto">
            {candidates.length === 0 ? (
              <p className="px-2 py-8 text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/60">
                {emptyMessage}
              </p>
            ) : (
              candidateGroups.map((group) => (
                <section key={group.key}>
                  <p className="mb-1 flex items-center gap-1.5 px-2 text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-muted-foreground/55">
                    <SpaceIcon icon={group.icon} className="size-3" />
                    <span className="min-w-0 truncate">{group.label}</span>
                  </p>
                  <div className="space-y-1">
                    {group.items.map((project) => {
                      const selected = selectedIds.has(project.id);
                      return (
                        <button
                          key={project.id}
                          type="button"
                          role="checkbox"
                          aria-checked={selected}
                          onClick={() =>
                            setSelectedIds((current) => {
                              const next = new Set(current);
                              if (next.has(project.id)) next.delete(project.id);
                              else next.add(project.id);
                              return next;
                            })
                          }
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left outline-hidden transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/45",
                            selected && "bg-foreground/7",
                          )}
                        >
                          <span className="relative flex size-4 shrink-0 items-center justify-center">
                            <ProjectSidebarIcon cwd={project.cwd} expanded={project.expanded} />
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground/88">
                            {project.name}
                          </span>
                          {/* Presentational: the row itself is the checkbox, so this must not
                              be another focusable control. Mirrors ui/checkbox's chrome. */}
                          <span
                            aria-hidden="true"
                            className={cn(
                              "flex size-4 shrink-0 items-center justify-center rounded-[.25rem] border transition-colors",
                              selected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-[color:var(--color-border-light)] bg-background",
                            )}
                          >
                            {selected ? <CheckIcon className="size-3" /> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))
            )}
          </div>
          {error ? (
            <p
              role="alert"
              className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive"
            >
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={selectedIds.size === 0 || submitting}>
            {submitting
              ? "Moving…"
              : selectedIds.size === 0
                ? "Move projects"
                : `Move ${selectedIds.size} project${selectedIds.size === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
