// Purpose: Project drag-and-drop sensors, collision detection, drag handlers, and drag-state refs from Sidebar.tsx.
// Layer: web hook (client-side interaction). Returns refs so project title handlers can read live drag state.
// Exports: useSidebarProjectDnd, SidebarProjectDndDeps, SidebarProjectDnd.

import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import {
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
  closestCorners,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { ProjectId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder } from "../appSettings";
import type { Project } from "../types";

export interface SidebarProjectDndDeps {
  sidebarProjectSortOrder: SidebarProjectSortOrder;
  projects: readonly Project[];
  reorderProjects: (activeProjectId: ProjectId, overProjectId: ProjectId) => void;
}

export interface SidebarProjectDnd {
  projectDnDSensors: ReturnType<typeof useSensors>;
  projectCollisionDetection: CollisionDetection;
  handleProjectDragEnd: (event: DragEndEvent) => void;
  handleProjectDragStart: (event: DragStartEvent) => void;
  handleProjectDragCancel: (event: DragCancelEvent) => void;
  dragInProgressRef: RefObject<boolean>;
  suppressProjectClickAfterDragRef: RefObject<boolean>;
}

export function useSidebarProjectDnd(deps: SidebarProjectDndDeps): SidebarProjectDnd {
  const { sidebarProjectSortOrder, projects, reorderProjects } = deps;

  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = projects.find((project) => project.id === active.id);
      const overProject = projects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(activeProject.id, overProject.id);
    },
    [sidebarProjectSortOrder, projects, reorderProjects],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  return {
    projectDnDSensors,
    projectCollisionDetection,
    handleProjectDragEnd,
    handleProjectDragStart,
    handleProjectDragCancel,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
  };
}
