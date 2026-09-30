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
  // Automatic selection follows task project edits. An explicit Run in choice stays
  // independent, including a custom folder, until the form is opened for another task.
  const [selectedTarget, setTarget] = useState<DelegateTarget | null>(null);
  // The layout's current project only seeds the form; switching spaces later must
  // not silently retarget an unassigned task. A deleted fallback requires a choice.
  const [fallbackProjectId] = useState(
    () =>
      userProjects.find((project) => project.id === latestProjectId)?.id ??
      userProjects[0]?.id ??
      null,
  );
  const preferredProjectId = todoProjectId ?? fallbackProjectId;
  const projectId = userProjects.some((project) => project.id === preferredProjectId)
    ? preferredProjectId
    : null;
  const target = useMemo<DelegateTarget | null>(
    () => selectedTarget ?? (projectId ? { kind: "project", projectId } : null),
    [projectId, selectedTarget],
  );
  const targetProject =
    target?.kind === "project"
      ? (userProjects.find((project) => project.id === target.projectId) ?? null)
      : null;

  return { target, setTarget, projectOptions, targetProject };
}

export type TaskDelegateTargetState = ReturnType<typeof useTaskDelegateTarget>;
