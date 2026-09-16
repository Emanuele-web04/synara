import type { ProjectId, ProjectTaskId, ThreadId } from "@synara/contracts";

export type ProjectAgentPrincipal =
  | { readonly kind: "user" }
  | {
      readonly kind: "coordinator";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    }
  | {
      readonly kind: "worker";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly taskId: ProjectTaskId;
    };

export function isUserPrincipal(principal: ProjectAgentPrincipal): boolean {
  return principal.kind === "user";
}

export function isCoordinatorPrincipal(
  principal: ProjectAgentPrincipal,
  projectId: ProjectId,
): boolean {
  return principal.kind === "coordinator" && principal.projectId === projectId;
}

export function canAcceptTask(principal: ProjectAgentPrincipal, projectId: ProjectId): boolean {
  return isUserPrincipal(principal) || isCoordinatorPrincipal(principal, projectId);
}

export function canStartGoal(principal: ProjectAgentPrincipal): boolean {
  return isUserPrincipal(principal);
}

export function canConfigureProject(principal: ProjectAgentPrincipal): boolean {
  return isUserPrincipal(principal);
}
