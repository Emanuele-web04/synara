// FILE: useTaskProjects.ts
// Purpose: The project lookups the Tasks view hands its rows and inspector — names and
//          folders by id, and the projects a to-do can be filed under.
// Layer: Tasks UI hook
// Exports: useTaskProjects

import { useMemo } from "react";

import { useStore } from "../../store";

export function useTaskProjects() {
  const projects = useStore((state) => state.projects);
  const projectNameById = useMemo(
    () => new Map<string, string>(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const projectCwdById = useMemo(
    () => new Map<string, string>(projects.map((project) => [project.id, project.cwd])),
    [projects],
  );
  const projectOptions = useMemo(
    () =>
      projects
        .filter((project) => project.kind === "project")
        .map((project) => ({ id: project.id, name: project.name })),
    [projects],
  );
  return { projectNameById, projectCwdById, projectOptions };
}
