// FILE: GroupLinkProjectDialog.tsx
// Purpose: Lets a group link an existing ordinary project as a repository.
// Layer: Group settings dialog

import type { ProjectId } from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";

import type { Project } from "~/types";
import { isOrdinarySpaceProject } from "~/lib/spaces";
import { abbreviateHomePath } from "~/components/sidebarHoverCardAnchors";
import { cn } from "~/lib/utils";
import { useWorkspacePathsStore } from "~/workspacePathsStore";
import { ProjectSidebarIcon } from "~/components/ProjectSidebarIcon";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { SearchInput } from "~/components/ui/search-input";

export function GroupLinkProjectDialog(props: {
  readonly open: boolean;
  readonly projects: ReadonlyArray<Project>;
  readonly linkedProjectIds: ReadonlyArray<ProjectId>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (projectId: ProjectId) => void;
}) {
  const [query, setQuery] = useState("");
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((state) => state.groupsWorkspaceRoot);

  useEffect(() => {
    if (!props.open) return;
    setQuery("");
  }, [props.open]);

  const candidates = useMemo(() => {
    const linked = new Set<ProjectId>(props.linkedProjectIds);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return props.projects
      .filter(
        (project) =>
          !linked.has(project.id) &&
          isOrdinarySpaceProject(project, {
            homeDir,
            chatWorkspaceRoot,
            studioWorkspaceRoot,
            groupsWorkspaceRoot,
          }) &&
          (normalizedQuery.length === 0 ||
            project.name.toLocaleLowerCase().includes(normalizedQuery) ||
            project.cwd.toLocaleLowerCase().includes(normalizedQuery)),
      )
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }, [
    chatWorkspaceRoot,
    groupsWorkspaceRoot,
    homeDir,
    props.linkedProjectIds,
    props.projects,
    query,
    studioWorkspaceRoot,
  ]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add repository</DialogTitle>
          <DialogDescription>
            Link an existing project so the group can work in its folder.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <SearchInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects"
          />
          <div className="max-h-72 overflow-y-auto">
            {candidates.length === 0 ? (
              <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">
                {query.trim().length > 0
                  ? "No matching projects."
                  : "No projects available to link."}
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {candidates.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left",
                        "text-[12px] text-foreground hover:bg-foreground/5",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      )}
                      onClick={() => props.onPick(project.id)}
                    >
                      <span className="relative flex size-4 shrink-0 items-center justify-center">
                        <ProjectSidebarIcon cwd={project.cwd} expanded={project.expanded} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      <span className="max-w-40 truncate text-[11px] text-muted-foreground">
                        {abbreviateHomePath(project.cwd, homeDir)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
