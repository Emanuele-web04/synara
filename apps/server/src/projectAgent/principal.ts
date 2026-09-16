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
    }
  | {
      readonly kind: "unmanaged";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    };

export function isUserPrincipal(principal: ProjectAgentPrincipal): boolean {
  return principal.kind === "user";
}

export function principalProjectId(principal: ProjectAgentPrincipal): ProjectId | null {
  return principal.kind === "user" ? null : principal.projectId;
}

export function canWriteUserOwnedDocuments(principal: ProjectAgentPrincipal): boolean {
  return isUserPrincipal(principal);
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
