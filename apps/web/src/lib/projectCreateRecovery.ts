// FILE: projectCreateRecovery.ts
// Purpose: Centralizes duplicate `project.create` error parsing and recovery helpers.
// Exports: duplicate-create error guards plus snapshot matching for import recovery.

import type { OrchestrationReadModel } from "@synara/contracts";
import { workspaceRootsEqual } from "@synara/shared/threadWorkspace";

const DUPLICATE_PROJECT_CREATE_ERROR_PREFIX =
  "Orchestration command invariant failed (project.create): Project '";
const DEFAULT_RECOVERY_MAX_ATTEMPTS = 6;
const DEFAULT_RECOVERY_DELAY_MS = 50;
const DEFAULT_RECOVERABLE_PROJECT_KINDS: ReadonlySet<string> = new Set(["project"]);

export interface DuplicateProjectCreateRecoveryCandidate {
  readonly id: string;
  readonly kind?: string | undefined;
  readonly workspaceRoot: string;
  readonly deletedAt?: string | null | undefined;
}

interface SnapshotWithProjects<T extends DuplicateProjectCreateRecoveryCandidate> {
  readonly projects: readonly T[];
}

interface ProjectLookupInput {
  readonly projectId?: string | null | undefined;
  readonly workspaceRoot?: string | null | undefined;
}

// Defaults to the original "project" kind so existing callers keep their current behavior;
// other providers (e.g. the Studio hidden container) can opt into their own kind set.
function isRecoverableProjectKind(
  kind: string | undefined,
  recoverableKinds: ReadonlySet<string> = DEFAULT_RECOVERABLE_PROJECT_KINDS,
): boolean {
  return recoverableKinds.has(kind ?? "project");
}

function isRecoverableActiveProject(
  project: DuplicateProjectCreateRecoveryCandidate,
  recoverableKinds?: ReadonlySet<string>,
): boolean {
  return (
    (project.deletedAt ?? null) === null && isRecoverableProjectKind(project.kind, recoverableKinds)
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Generic retry-with-backoff loop shared by every duplicate-create recovery flow: poll
// `loadSnapshot` with linear backoff, then fall back to `repairSnapshot` once before giving up.
// This is the single source of the 6-attempt / 50ms-backoff shape used across recovery helpers.
export async function waitForSnapshotMatch<TSnapshot, TMatch>(input: {
  readonly loadSnapshot: () => Promise<TSnapshot | null>;
  readonly findMatch: (snapshot: TSnapshot) => TMatch | null;
  readonly repairSnapshot?: (() => Promise<TSnapshot | null>) | undefined;
  readonly maxAttempts?: number | undefined;
  readonly delayMs?: number | undefined;
}): Promise<{ match: TMatch | null; snapshot: TSnapshot | null }> {
  let latestSnapshot: TSnapshot | null = null;
  const maxAttempts = input.maxAttempts ?? DEFAULT_RECOVERY_MAX_ATTEMPTS;
  const delayMs = input.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshot = await input.loadSnapshot();
    if (snapshot) {
      latestSnapshot = snapshot;
      const match = input.findMatch(snapshot);
      if (match) {
        return { match, snapshot };
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
      const repairedMatch = input.findMatch(repairedSnapshot);
      if (repairedMatch) {
        return { match: repairedMatch, snapshot: repairedSnapshot };
      }
    }
  }

  return { match: null, snapshot: latestSnapshot };
}

// Shared machinery behind the hidden-container candidate helpers used by Studio and home-chat
// project recovery: normalizes the cwd/workspaceRoot field naming difference between local store
// projects and shell-snapshot rows, and finds a candidate by id via a caller-supplied predicate.
export interface ContainerCandidateFields {
  readonly cwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
}

export function resolveContainerCandidateCwd(
  candidate: ContainerCandidateFields | null | undefined,
): string {
  return candidate?.cwd ?? candidate?.workspaceRoot ?? "";
}

export function findContainerCandidateById<T extends { readonly id?: string | undefined }>(
  projects: readonly T[],
  projectId: string,
  isContainerCandidate: (project: T) => boolean,
): T | null {
  return (
    projects.find((project) => project.id === projectId && isContainerCandidate(project)) ?? null
  );
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
    readonly recoverableKinds?: ReadonlySet<string> | undefined;
  },
): T | null {
  if (input.projectId) {
    const projectById = input.projects.find(
      (project) =>
        isRecoverableActiveProject(project, input.recoverableKinds) &&
        project.id === input.projectId,
    );
    if (projectById) {
      return projectById;
    }
  }

  if (!input.workspaceRoot) {
    return null;
  }

  const workspaceRoot = input.workspaceRoot;
  return (
    input.projects.find(
      (project) =>
        isRecoverableActiveProject(project, input.recoverableKinds) &&
        workspaceRootsEqual(project.workspaceRoot, workspaceRoot),
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
  readonly recoverableKinds?: ReadonlySet<string> | undefined;
}): T | null {
  if (!isDuplicateProjectCreateError(input.message)) {
    return null;
  }

  return findRecoverableProject({
    projects: input.projects,
    projectId: extractDuplicateProjectCreateProjectId(input.message),
    workspaceRoot: input.workspaceRoot,
    recoverableKinds: input.recoverableKinds,
  });
}

export async function waitForRecoverableProjectInReadModel<
  TSnapshot extends SnapshotWithProjects<DuplicateProjectCreateRecoveryCandidate> =
    OrchestrationReadModel,
>(
  input: ProjectLookupInput & {
    readonly loadSnapshot: () => Promise<TSnapshot | null>;
    readonly repairSnapshot?: (() => Promise<TSnapshot | null>) | undefined;
    readonly maxAttempts?: number | undefined;
    readonly delayMs?: number | undefined;
    readonly recoverableKinds?: ReadonlySet<string> | undefined;
  },
): Promise<{
  project: TSnapshot["projects"][number] | null;
  snapshot: TSnapshot | null;
}> {
  const { match, snapshot } = await waitForSnapshotMatch<TSnapshot, TSnapshot["projects"][number]>({
    loadSnapshot: input.loadSnapshot,
    repairSnapshot: input.repairSnapshot,
    maxAttempts: input.maxAttempts,
    delayMs: input.delayMs,
    findMatch: (candidateSnapshot) =>
      findRecoverableProject({
        projects: candidateSnapshot.projects,
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
        recoverableKinds: input.recoverableKinds,
      }) as TSnapshot["projects"][number] | null,
  });

  return { project: match, snapshot };
}

// Retries snapshot reads briefly so freshly restored projects can be reused by the first-send flow.
export async function waitForRecoverableProjectForDuplicateCreate<
  TSnapshot extends SnapshotWithProjects<DuplicateProjectCreateRecoveryCandidate>,
>(input: {
  readonly message: string;
  readonly workspaceRoot: string;
  readonly loadSnapshot: () => Promise<TSnapshot | null>;
  readonly repairSnapshot?: (() => Promise<TSnapshot | null>) | undefined;
  readonly maxAttempts?: number | undefined;
  readonly delayMs?: number | undefined;
  readonly recoverableKinds?: ReadonlySet<string> | undefined;
}): Promise<{
  project: TSnapshot["projects"][number] | null;
  snapshot: TSnapshot | null;
}> {
  const { match, snapshot } = await waitForSnapshotMatch<TSnapshot, TSnapshot["projects"][number]>({
    loadSnapshot: input.loadSnapshot,
    repairSnapshot: input.repairSnapshot,
    maxAttempts: input.maxAttempts,
    delayMs: input.delayMs,
    findMatch: (candidateSnapshot) =>
      findRecoverableProjectForDuplicateCreate({
        message: input.message,
        projects: candidateSnapshot.projects,
        workspaceRoot: input.workspaceRoot,
        recoverableKinds: input.recoverableKinds,
      }) as TSnapshot["projects"][number] | null,
  });

  return { project: match, snapshot };
}
