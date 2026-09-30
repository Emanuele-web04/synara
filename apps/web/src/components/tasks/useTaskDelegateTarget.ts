// FILE: useTaskDelegateTarget.ts
// Purpose: The "Run in" choice of the Tasks delegate form — a project or a picked
//          folder — seeded from the to-do's project, then the latest project, then the
//          first one.
// Layer: Tasks UI hook
// Exports: useTaskDelegateTarget, DelegateTarget, TaskDelegateTargetState

import type { ProjectId, Todo } from "@synara/contracts";
import { useMemo, useState } from "react";

import { useLatestProjectStore } from "../../latestProjectStore";
import { useStore } from "../../store";

export type DelegateTarget =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "folder"; readonly path: string };

export function useTaskDelegateTarget(todoProjectId: Todo["projectId"]) {
  const projects = useStore((state) => state.projects);
  const latestProjectId = useLatestProjectStore((state) => state.latestProjectId);
  const userProjects = useMemo(
    () => projects.filter((project) => project.kind === "project"),
    [projects],
  );
  const projectOptions = useMemo(
    () => userProjects.map((project) => ({ id: project.id, name: project.name })),
    [userProjects],
  );
  const [target, setTarget] = useState<DelegateTarget | null>(() => {
    const preferred = [todoProjectId, latestProjectId].find(
      (id) => id !== null && userProjects.some((project) => project.id === id),
    );
    const projectId = preferred ?? userProjects[0]?.id ?? null;
    return projectId ? { kind: "project", projectId } : null;
  });
  const targetProject =
    target?.kind === "project"
      ? (userProjects.find((project) => project.id === target.projectId) ?? null)
      : null;

  return { target, setTarget, projectOptions, targetProject };
}

export type TaskDelegateTargetState = ReturnType<typeof useTaskDelegateTarget>;
