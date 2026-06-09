import { useMemo } from "react";

import { useStore } from "../../store";
import { createProjectsByKindSelector } from "../../storeSelectors";
import type { Project } from "../../types";

export interface ReviewCwdResolution {
  resolvedCwd: string | null;
  projects: readonly Project[];
  selectedProjectName: string;
}

export function useReviewCwd(requestedCwd: string | undefined): ReviewCwdResolution {
  const projects = useStore(useMemo(() => createProjectsByKindSelector("project"), []));

  const resolvedCwd = useMemo(() => {
    if (requestedCwd) {
      return requestedCwd;
    }
    return projects[0]?.cwd ?? null;
  }, [projects, requestedCwd]);

  const selectedProject = projects.find((project) => project.cwd === resolvedCwd);
  const selectedProjectName = selectedProject
    ? (selectedProject.localName ?? selectedProject.name)
    : "Select a project";

  return { resolvedCwd, projects, selectedProjectName };
}
