import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationSpace,
  OrchestrationThread,
  ProjectKind,
  ProjectId,
  SpaceId,
  ThreadId,
} from "@synara/contracts";
import { THREAD_NOT_ARCHIVED_INVARIANT_MARKER } from "@synara/shared/errorMessages";
import {
  normalizeWorkspaceRootForComparison,
  workspaceRootsEqual,
} from "@synara/shared/threadWorkspace";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function findSpaceById(
  readModel: OrchestrationReadModel,
  spaceId: SpaceId,
): OrchestrationSpace | undefined {
  return readModel.spaces.find((space) => space.id === spaceId);
}

export function listActiveSpaces(
  readModel: OrchestrationReadModel,
): ReadonlyArray<OrchestrationSpace> {
  return readModel.spaces
    .filter((space) => space.deletedAt === null)
    .toSorted((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
}

export function requireSpace(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly spaceId: SpaceId;
}): Effect.Effect<OrchestrationSpace, OrchestrationCommandInvariantError> {
  const space = findSpaceById(input.readModel, input.spaceId);
  if (space && space.deletedAt === null) {
    return Effect.succeed(space);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      space
        ? `Space '${input.spaceId}' was deleted and cannot handle command '${input.command.type}'.`
        : `Space '${input.spaceId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireSpaceAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly spaceId: SpaceId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Aggregate ids are durable event-stream identities, not recyclable row ids. A deleted
  // Space remains in the read model as a tombstone; recreating it would append a second
  // `space.created` lifecycle to the same aggregate and make replay semantics ambiguous.
  if (!findSpaceById(input.readModel, input.spaceId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Space '${input.spaceId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireSpaceNameAvailable(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly name: string;
  readonly excludeSpaceId?: SpaceId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedName = input.name.trim().toLowerCase();
  if (normalizedName === "void") {
    return Effect.fail(
      invariantError(input.command.type, "'Void' is reserved for unassigned projects."),
    );
  }
  const conflict = input.readModel.spaces.find(
    (space) =>
      space.deletedAt === null &&
      space.id !== input.excludeSpaceId &&
      space.name.trim().toLowerCase() === normalizedName,
  );
  if (!conflict) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(input.command.type, `A space named '${input.name}' already exists.`),
  );
}

export interface SpaceAssignmentWorkspacePaths {
  readonly homeDir: string;
  readonly chatWorkspaceRoot: string;
}

/**
 * Server half of the web's `isOrdinarySpaceProject` membership rule. Managed chat and
 * Studio containers are excluded by kind alone, but legacy Home chat containers kept
 * `kind: "project"` — they are recognizable by the reserved home/chat workspace root plus
 * their canonical "Home" title. Those containers are reachable from every Space, so they
 * must never belong to one. The decider rejects renaming this legacy row so the signal cannot
 * drift through supported commands.
 */
export function isLegacyHomeChatContainerRow(input: {
  readonly projectTitle: string;
  readonly projectWorkspaceRoot: string;
  readonly workspacePaths: SpaceAssignmentWorkspacePaths | undefined;
}): boolean {
  const homeDir = input.workspacePaths?.homeDir.trim() ?? "";
  if (homeDir.length === 0 || input.projectTitle !== "Home") {
    return false;
  }
  const chatWorkspaceRoot = input.workspacePaths?.chatWorkspaceRoot.trim() || homeDir;
  const comparisonOptions = { platform: process.platform } as const;
  return (
    workspaceRootsEqual(input.projectWorkspaceRoot, chatWorkspaceRoot, comparisonOptions) ||
    workspaceRootsEqual(input.projectWorkspaceRoot, homeDir, comparisonOptions)
  );
}

/** The rejecting form for explicit assignment commands, where a bad target is an error. */
export function requireSpaceAssignableProject(input: {
  readonly command: OrchestrationCommand;
  readonly projectTitle: string;
  readonly projectWorkspaceRoot: string;
  readonly workspacePaths: SpaceAssignmentWorkspacePaths | undefined;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!isLegacyHomeChatContainerRow(input)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      "The Chats container is reachable from every space and cannot be assigned to one.",
    ),
  );
}

// Finds active projects by workspace root using the same comparison rules as import flows.
export function listActiveProjectsByWorkspaceRoot(
  readModel: OrchestrationReadModel,
  workspaceRoot: string,
  options?: { readonly kinds?: ReadonlySet<ProjectKind> },
): ReadonlyArray<OrchestrationProject> {
  const normalizedWorkspaceRoot = normalizeWorkspaceRootForComparison(workspaceRoot, {
    platform: process.platform,
  });
  const acceptedKinds = options?.kinds ?? new Set<ProjectKind>(["project"]);
  return readModel.projects.filter(
    (project) =>
      project.deletedAt === null &&
      acceptedKinds.has(project.kind ?? "project") &&
      normalizeWorkspaceRootForComparison(project.workspaceRoot, {
        platform: process.platform,
      }) === normalizedWorkspaceRoot,
  );
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireProjectWorkspaceRootAvailable(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly excludeProjectId?: ProjectId;
  readonly kinds?: ReadonlySet<ProjectKind>;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Skip the excluded project BEFORE picking, not after: if corrupt state ever leaves two
  // active owners on one root, the project being updated must not mask the other owner.
  const existingProject = listActiveProjectsByWorkspaceRoot(
    input.readModel,
    input.workspaceRoot,
    input.kinds ? { kinds: input.kinds } : undefined,
  ).find((project) => project.id !== input.excludeProjectId);
  if (!existingProject) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${existingProject.id}' already uses workspace root '${existingProject.workspaceRoot}'.`,
    ),
  );
}

export function requireProjectHasNoThreads(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const remainingThreads = listThreadsByProjectId(input.readModel, input.projectId).filter(
    (thread) => thread.deletedAt === null,
  );
  if (remainingThreads.length === 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' still has ${remainingThreads.length} thread${remainingThreads.length === 1 ? "" : "s"} and cannot be deleted.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread && thread.deletedAt === null) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      thread
        ? `Thread '${input.threadId}' was deleted and cannot handle command '${input.command.type}'.`
        : `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt != null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' ${THREAD_NOT_ARCHIVED_INVARIANT_MARKER} '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt == null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
