// FILE: projectCreateRecovery.ts
// Purpose: Centralizes duplicate `project.create` error parsing and recovery helpers.
// Exports: duplicate-create error guards plus snapshot matching for import recovery.

import type { OrchestrationReadModel } from "@t3tools/contracts";
import { workspaceRootsEqual } from "@t3tools/shared/threadWorkspace";

const DUPLICATE_PROJECT_CREATE_ERROR_PREFIX =
  "Orchestration command invariant failed (project.create): Project '";
const DEFAULT_RECOVERY_MAX_ATTEMPTS = 6;
const DEFAULT_RECOVERY_DELAY_MS = 50;

export interface DuplicateProjectCreateRecoveryCandidate {
  readonly id: string;
  readonly kind?: string | undefined;
  readonly workspaceRoot: string;
  readonly deletedAt: string | null;
}

interface SnapshotWithProjects<T extends DuplicateProjectCreateRecoveryCandidate> {
  readonly projects: readonly T[];
}

interface ProjectLookupInput {
  readonly projectId?: string | null | undefined;
  readonly workspaceRoot?: string | null | undefined;
}

function isRecoverableProjectKind(kind: string | undefined): boolean {
  return (kind ?? "project") === "project";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Parses the invariant text so the UI can recover existing projects instead of failing imports.
export function isDuplicateProjectCreateError(message: string): boolean {
  if (!message.startsWith(DUPLICATE_PROJECT_CREATE_ERROR_PREFIX)) {
    return false;
  }

  const duplicateMarkerIndex = message.indexOf("' already uses workspace root '");
  return duplicateMarkerIndex > DUPLICATE_PROJECT_CREATE_ERROR_PREFIX.length;
}

export function extractDuplicateProjectCreateProjectId(message: string): string | null {
  if (!isDuplicateProjectCreateError(message)) {
    return null;
  }

  const duplicateMarkerIndex = message.indexOf("' already uses workspace root '");
  return message.slice(DUPLICATE_PROJECT_CREATE_ERROR_PREFIX.length, duplicateMarkerIndex) || null;
}

export function findRecoverableProject<T extends DuplicateProjectCreateRecoveryCandidate>(
  input: ProjectLookupInput & {
    readonly projects: readonly T[];
  },
): T | null {
  if (input.projectId) {
    const projectById = input.projects.find(
      (project) =>
        project.deletedAt === null &&
        isRecoverableProjectKind(project.kind) &&
        project.id === input.projectId,
    );
    if (projectById) {
      return projectById;
    }
  }

  if (!input.workspaceRoot) {
    return null;
  }

  return (
    input.projects.find(
      (project) =>
        project.deletedAt === null &&
        isRecoverableProjectKind(project.kind) &&
        workspaceRootsEqual(project.workspaceRoot, input.workspaceRoot),
    ) ?? null
  );
}

// Prefers the explicit duplicate id, then falls back to workspace-root matching for older clients.
export function findRecoverableProjectForDuplicateCreate<
  T extends DuplicateProjectCreateRecoveryCandidate,
>(input: {
  readonly message: string;
  readonly projects: readonly T[];
  readonly workspaceRoot: string;
}): T | null {
  if (!isDuplicateProjectCreateError(input.message)) {
    return null;
  }

  return findRecoverableProject({
    projects: input.projects,
    projectId: extractDuplicateProjectCreateProjectId(input.message),
    workspaceRoot: input.workspaceRoot,
  });
}

export async function waitForRecoverableProjectInReadModel(input: ProjectLookupInput & {
  readonly loadSnapshot: () => Promise<OrchestrationReadModel | null>;
  readonly repairSnapshot?: (() => Promise<OrchestrationReadModel | null>) | undefined;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
}): Promise<{
  project: OrchestrationReadModel["projects"][number] | null;
  snapshot: OrchestrationReadModel | null;
}> {
  let latestSnapshot: OrchestrationReadModel | null = null;
  const maxAttempts = input.maxAttempts ?? DEFAULT_RECOVERY_MAX_ATTEMPTS;
  const delayMs = input.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshot = await input.loadSnapshot();
    if (snapshot) {
      latestSnapshot = snapshot;
      const project = findRecoverableProject({
        projects: snapshot.projects,
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
      });
      if (project) {
        return { project, snapshot };
      }
    }

    if (attempt < maxAttempts) {
      await wait(delayMs * attempt);
    }
  }

  if (input.repairSnapshot) {
    const repairedSnapshot = await input.repairSnapshot();
    if (repairedSnapshot) {
      latestSnapshot = repairedSnapshot;
      const repairedProject = findRecoverableProject({
        projects: repairedSnapshot.projects,
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
      });
      if (repairedProject) {
        return {
          project: repairedProject,
          snapshot: repairedSnapshot,
        };
      }
    }
  }

  return {
    project: null,
    snapshot: latestSnapshot,
  };
}

// Retries snapshot reads briefly so freshly restored projects can be reused by the first-send flow.
export async function waitForRecoverableProjectForDuplicateCreate<
  TSnapshot extends SnapshotWithProjects<DuplicateProjectCreateRecoveryCandidate>,
>(input: {
  readonly message: string;
  readonly workspaceRoot: string;
  readonly loadSnapshot: () => Promise<TSnapshot | null>;
  readonly repairSnapshot?: (() => Promise<TSnapshot | null>) | undefined;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
}): Promise<{
  project: TSnapshot["projects"][number] | null;
  snapshot: TSnapshot | null;
}> {
  let latestSnapshot: TSnapshot | null = null;
  const maxAttempts = input.maxAttempts ?? DEFAULT_RECOVERY_MAX_ATTEMPTS;
  const delayMs = input.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshot = await input.loadSnapshot();
    if (snapshot) {
      latestSnapshot = snapshot;
      const project = findRecoverableProjectForDuplicateCreate({
        message: input.message,
        projects: snapshot.projects,
        workspaceRoot: input.workspaceRoot,
      }) as TSnapshot["projects"][number] | null;
      if (project) {
        return { project, snapshot };
      }
    }

    if (attempt < maxAttempts) {
      await wait(delayMs * attempt);
    }
  }

  if (input.repairSnapshot) {
    const repairedSnapshot = await input.repairSnapshot();
    if (repairedSnapshot) {
      latestSnapshot = repairedSnapshot;
      const repairedProject = findRecoverableProjectForDuplicateCreate({
        message: input.message,
        projects: repairedSnapshot.projects,
        workspaceRoot: input.workspaceRoot,
      }) as TSnapshot["projects"][number] | null;
      if (repairedProject) {
        return {
          project: repairedProject,
          snapshot: repairedSnapshot,
        };
      }
    }
  }

  return {
    project: null,
    snapshot: latestSnapshot,
  };
}
