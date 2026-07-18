import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThreadPullRequest,
  OrchestrationWorktreeWorkspace,
  ProjectKind,
  ThreadMarker,
} from "@synara/contracts";
import {
  MAX_PINNED_PROJECTS,
  PINNED_MESSAGES_MAX_COUNT,
  THREAD_MARKERS_MAX_COUNT,
  TurnId,
} from "@synara/contracts";
import {
  deriveAssociatedWorktreeMetadata,
  deriveAssociatedWorktreeMetadataPatch,
} from "@synara/shared/threadWorkspace";
import { doThreadMarkerRangesOverlap } from "@synara/shared/threadMarkers";
import {
  findWorkspaceForPullRequest,
  pullRequestFromSourceRef,
  pullRequestsMatch,
  workspaceReferencesPullRequest,
} from "@synara/shared/pullRequest";
import {
  collectTailTurnIds,
  resolveTailUserMessageEditTarget,
} from "@synara/shared/conversationEdit";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { hasNativeHandoffMessages } from "./handoff.ts";
import { resolveStableMessageTurnId } from "./messageTurnId.ts";
import {
  listActiveProjectsByWorkspaceRoot,
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireProjectHasNoThreads,
  requireProjectWorkspaceRootAvailable,
  requireThread,
  requireThreadAbsent,
  requireThreadArchived,
  requireThreadNotArchived,
  requireWorkspace,
  requireWorkspaceAbsent,
} from "./commandInvariants.ts";

const nowIso = () => new Date().toISOString();
const DEFAULT_ASSISTANT_DELIVERY_MODE = "buffered" as const;
const STUDIO_PROJECT_KIND_SET = new Set<ProjectKind>(["studio"]);
// Kinds that claim exclusive ownership of a workspace root. Chat containers are excluded: they
// use placeholder roots (e.g. the home dir) that legitimately coexist with real projects.
const WORKSPACE_OWNING_PROJECT_KIND_SET = new Set<ProjectKind>(["project", "studio"]);

type PullRequestReference = Pick<OrchestrationThreadPullRequest, "number" | "url">;

function findReservedWorkspaceForPullRequest(input: {
  readonly readModel: OrchestrationReadModel;
  readonly projectId: string;
  readonly pullRequest: PullRequestReference;
  readonly excludeWorkspaceId?: string;
}): OrchestrationWorktreeWorkspace | undefined {
  return (
    findWorkspaceForPullRequest(
      (input.readModel.workspaces ?? []).filter(
        (workspace) => workspace.id !== input.excludeWorkspaceId,
      ),
      input.projectId,
      input.pullRequest,
    ) ?? undefined
  );
}

function duplicatePullRequestWorkspaceDetail(
  pullRequest: PullRequestReference,
  workspace: OrchestrationWorktreeWorkspace,
): string {
  return workspace.state === "archived"
    ? `Pull request #${pullRequest.number} belongs to archived workspace '${workspace.id}'. Restore that workspace instead.`
    : `Pull request #${pullRequest.number} is already attached to workspace '${workspace.id}'.`;
}

const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

function omitNullUserInputAnswers(
  command: Extract<OrchestrationCommand, { type: "thread.user-input.respond" }>,
) {
  return Object.fromEntries(
    Object.entries(command.answers).filter(([, answer]) => answer !== null && answer !== undefined),
  );
}

function countPinnedProjects(
  readModel: OrchestrationReadModel,
  options?: { readonly excludeProjectIds?: ReadonlySet<string> },
): number {
  return readModel.projects.filter(
    (project) =>
      project.deletedAt === null &&
      project.kind === "project" &&
      project.isPinned === true &&
      !options?.excludeProjectIds?.has(project.id),
  ).length;
}

function validateProjectPinLimit(input: {
  readonly command: Extract<
    OrchestrationCommand,
    { type: "project.create" | "project.meta.update" }
  >;
  readonly readModel: OrchestrationReadModel;
  readonly projectId: OrchestrationEvent["aggregateId"];
  readonly nextKind: ProjectKind;
  readonly nextDeletedAt?: string | null;
  readonly wasPinned?: boolean;
  readonly staleProjectIds?: ReadonlySet<string>;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // The kind invariant must hold for the EFFECTIVE pin state, not only when the command sets
  // isPinned: a kind-only update (e.g. project -> studio) would otherwise carry an existing pin
  // onto a kind that can never be pinned.
  const nextIsPinned = input.command.isPinned ?? input.wasPinned ?? false;
  if (nextIsPinned && input.nextKind !== "project") {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Only projects can be pinned.`,
      }),
    );
  }

  if (input.command.isPinned !== true) {
    return Effect.void;
  }

  if (input.nextDeletedAt !== undefined && input.nextDeletedAt !== null) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Deleted project '${input.projectId}' cannot be pinned.`,
      }),
    );
  }

  if (input.wasPinned === true) {
    return Effect.void;
  }

  const excludeProjectIds = new Set<string>([input.projectId, ...(input.staleProjectIds ?? [])]);
  const pinnedProjectCount = countPinnedProjects(input.readModel, { excludeProjectIds });
  if (pinnedProjectCount < MAX_PINNED_PROJECTS) {
    return Effect.void;
  }

  return Effect.fail(
    new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail: `Only ${MAX_PINNED_PROJECTS} projects can be pinned at once.`,
    }),
  );
}

function deriveCommandAssociatedWorktreeMetadata(input: {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly associatedWorktreePath?: string | null;
  readonly associatedWorktreeBranch?: string | null;
  readonly associatedWorktreeRef?: string | null;
}) {
  return deriveAssociatedWorktreeMetadata({
    branch: input.branch,
    worktreePath: input.worktreePath,
    ...(input.associatedWorktreePath !== undefined
      ? { associatedWorktreePath: input.associatedWorktreePath }
      : {}),
    ...(input.associatedWorktreeBranch !== undefined
      ? { associatedWorktreeBranch: input.associatedWorktreeBranch }
      : {}),
    ...(input.associatedWorktreeRef !== undefined
      ? { associatedWorktreeRef: input.associatedWorktreeRef }
      : {}),
  });
}

function deriveCommandAssociatedWorktreeMetadataPatch(input: {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly associatedWorktreePath?: string | null;
  readonly associatedWorktreeBranch?: string | null;
  readonly associatedWorktreeRef?: string | null;
}) {
  return deriveAssociatedWorktreeMetadataPatch({
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
    ...(input.associatedWorktreePath !== undefined
      ? { associatedWorktreePath: input.associatedWorktreePath }
      : {}),
    ...(input.associatedWorktreeBranch !== undefined
      ? { associatedWorktreeBranch: input.associatedWorktreeBranch }
      : {}),
    ...(input.associatedWorktreeRef !== undefined
      ? { associatedWorktreeRef: input.associatedWorktreeRef }
      : {}),
  });
}

function deriveConversationRollbackTarget(
  messages: OrchestrationReadModel["threads"][number]["messages"],
  messageId: string,
): {
  readonly role: OrchestrationReadModel["threads"][number]["messages"][number]["role"];
  readonly removedTurnIds: ReadonlySet<string>;
} | null {
  const targetIndex = messages.findIndex((message) => message.id === messageId);
  if (targetIndex < 0) {
    return null;
  }

  return {
    role: messages[targetIndex]!.role,
    removedTurnIds: new Set(collectTailTurnIds({ messages, messageId })),
  };
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
      const staleProjects: Array<OrchestrationReadModel["projects"][number]> = [];
      const nextProjectKind = command.kind ?? "project";
      if (nextProjectKind === "project") {
        // The app-managed Studio container owns its root exclusively and is never retired here:
        // silently deleting it would orphan Studio threads, so adding its folder as a project
        // is rejected outright.
        const existingStudioProject = listActiveProjectsByWorkspaceRoot(
          readModel,
          command.workspaceRoot,
          { kinds: STUDIO_PROJECT_KIND_SET },
        )[0];
        if (existingStudioProject) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Project '${existingStudioProject.id}' already uses workspace root '${existingStudioProject.workspaceRoot}'.`,
          });
        }
        const existingProjects = listActiveProjectsByWorkspaceRoot(
          readModel,
          command.workspaceRoot,
        );
        for (const existingProject of existingProjects) {
          const remainingThreads = listThreadsByProjectId(readModel, existingProject.id).filter(
            (thread) => thread.deletedAt === null,
          );
          if (remainingThreads.length > 0) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Project '${existingProject.id}' already uses workspace root '${existingProject.workspaceRoot}'.`,
            });
          }
          staleProjects.push(existingProject);
        }

        for (const staleProject of staleProjects) {
          // A removed folder can leave an active project shell with no live threads.
          // Retire that stale shell so re-adding the same folder creates a fresh project.
          events.push({
            ...withEventBase({
              aggregateKind: "project",
              aggregateId: staleProject.id,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            }),
            type: "project.deleted",
            payload: {
              projectId: staleProject.id,
              deletedAt: command.createdAt,
            },
          });
        }
      }
      if (nextProjectKind === "studio") {
        // Cross-kind on purpose: a regular project already using this root would otherwise
        // coexist with the Studio container, breaking workspace-root-to-project uniqueness
        // that shell snapshot mapping and duplicate recovery rely on.
        const existingOwningProject = listActiveProjectsByWorkspaceRoot(
          readModel,
          command.workspaceRoot,
          { kinds: WORKSPACE_OWNING_PROJECT_KIND_SET },
        )[0];
        if (existingOwningProject) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Project '${existingOwningProject.id}' already uses workspace root '${existingOwningProject.workspaceRoot}'.`,
          });
        }
      }
      yield* validateProjectPinLimit({
        command,
        readModel,
        projectId: command.projectId,
        nextKind: nextProjectKind,
        staleProjectIds: new Set(staleProjects.map((project) => project.id)),
      });

      events.push({
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          kind: nextProjectKind,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          isPinned: command.isPinned,
          repositoryIdentity: command.repositoryIdentity ?? null,
          defaultTargetRef: command.defaultTargetRef ?? null,
          githubAccount: command.githubAccount ?? null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      });
      return events.length === 1 ? events[0]! : events;
    }

    case "project.meta.update": {
      const existingProject = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const nextProjectKind = command.kind ?? existingProject.kind ?? "project";
      // Ownership must hold for the project's *effective* root, not only when the root field is
      // present on the command: a kind-only update (e.g. chat -> studio) would otherwise slip a
      // second workspace-owning project onto a root that a project- or studio-kind row already
      // claims, bypassing the same cross-kind rule project.create enforces.
      const ownershipMayChange =
        command.workspaceRoot !== undefined ||
        (command.kind !== undefined && command.kind !== (existingProject.kind ?? "project"));
      if (ownershipMayChange && nextProjectKind !== "chat") {
        yield* requireProjectWorkspaceRootAvailable({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot ?? existingProject.workspaceRoot,
          excludeProjectId: command.projectId,
          kinds: WORKSPACE_OWNING_PROJECT_KIND_SET,
        });
      }
      yield* validateProjectPinLimit({
        command,
        readModel,
        projectId: command.projectId,
        nextKind: nextProjectKind,
        nextDeletedAt: existingProject.deletedAt,
        wasPinned: existingProject.isPinned === true,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.kind !== undefined ? { kind: command.kind } : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          ...(command.isPinned !== undefined ? { isPinned: command.isPinned } : {}),
          ...(command.repositoryIdentity !== undefined
            ? { repositoryIdentity: command.repositoryIdentity }
            : {}),
          ...(command.defaultTargetRef !== undefined
            ? { defaultTargetRef: command.defaultTargetRef }
            : {}),
          ...(command.githubAccount !== undefined ? { githubAccount: command.githubAccount } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireProjectHasNoThreads({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted",
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "workspace.create": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if ((project.kind ?? "project") !== "project") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Only repository projects can own worktree workspaces.`,
        });
      }
      yield* requireWorkspaceAbsent({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });

      const sourceKind = command.sourceKind ?? "new-branch";
      const requestedPullRequest = command.lastKnownPr ?? null;
      const pullRequestSource = pullRequestFromSourceRef(command.sourceRef);
      if (sourceKind === "pull-request") {
        if (!requestedPullRequest || !pullRequestSource) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail:
              "Pull-request workspaces require durable pull request metadata and a canonical pull request URL source.",
          });
        }
        if (!pullRequestsMatch(requestedPullRequest, pullRequestSource)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail:
              "The pull request source URL does not match the requested pull request metadata.",
          });
        }
        const existingPrWorkspace = findReservedWorkspaceForPullRequest({
          readModel,
          projectId: command.projectId,
          pullRequest: requestedPullRequest,
        });
        if (existingPrWorkspace) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: duplicatePullRequestWorkspaceDetail(requestedPullRequest, existingPrWorkspace),
          });
        }
      } else if (requestedPullRequest) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Pull request metadata requires sourceKind 'pull-request'.",
        });
      }

      const targetRef = requestedPullRequest?.baseBranch ?? command.targetRef;
      const branch = command.branch ?? requestedPullRequest?.headBranch ?? null;
      const sourceRef = command.sourceRef ?? command.targetRef;

      const workspaceEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workspace.created",
        payload: {
          workspaceId: command.workspaceId,
          projectId: command.projectId,
          repositoryIdentity: project.repositoryIdentity ?? null,
          kind: "managed",
          state: "provisioning",
          title: command.title,
          path: null,
          branch,
          headRef: null,
          targetRef,
          targetResolvedCommit: null,
          createdFromCommit: null,
          sourceKind,
          sourceRef,
          setupStatus: "pending",
          setupError: null,
          setupLogId: null,
          lastKnownPr: requestedPullRequest,
          isPinned: false,
          lifecycleGeneration: 1,
          activeOperation: {
            id: command.operationId,
            generation: 1,
            kind: "provision",
            stage: "intent-recorded",
            startedAt: command.createdAt,
          },
          lastFailure: null,
          mutationRevision: 0,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
          archivedAt: null,
          deletedAt: null,
        },
      };
      const threadEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          workspaceId: command.workspaceId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          envMode: "worktree",
          branch: null,
          worktreePath: null,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
          createBranchFlowCompleted: false,
          isPinned: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          sidechatSourceThreadId: null,
          lastKnownPr: requestedPullRequest,
          handoff: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      return [workspaceEvent, threadEvent];
    }

    case "workspace.attach": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireWorkspaceAbsent({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestedPullRequest =
        command.lastKnownPr ?? pullRequestFromSourceRef(command.sourceRef);
      if (requestedPullRequest) {
        const existingPrWorkspace = findReservedWorkspaceForPullRequest({
          readModel,
          projectId: command.projectId,
          pullRequest: requestedPullRequest,
        });
        if (existingPrWorkspace) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: duplicatePullRequestWorkspaceDetail(requestedPullRequest, existingPrWorkspace),
          });
        }
      }
      const existingPath = (readModel.workspaces ?? []).find(
        (workspace) =>
          workspace.projectId === command.projectId &&
          workspace.deletedAt === null &&
          workspace.path === command.path,
      );
      if (existingPath) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workspace '${existingPath.id}' already uses '${command.path}'.`,
        });
      }

      const workspaceEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workspace.created",
        payload: {
          workspaceId: command.workspaceId,
          projectId: command.projectId,
          repositoryIdentity: project.repositoryIdentity ?? null,
          kind: "external",
          state: "ready",
          title: command.title,
          path: command.path,
          branch: command.branch,
          headRef: command.headRef,
          targetRef: command.targetRef,
          targetResolvedCommit: command.headRef,
          createdFromCommit: command.headRef,
          sourceKind: command.sourceKind,
          sourceRef: command.sourceRef,
          setupStatus: "skipped",
          setupError: null,
          setupLogId: null,
          lastKnownPr: command.lastKnownPr ?? null,
          isPinned: false,
          lifecycleGeneration: 0,
          activeOperation: null,
          lastFailure: null,
          mutationRevision: 0,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
          archivedAt: null,
          deletedAt: null,
        },
      };
      const threadEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          workspaceId: command.workspaceId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          envMode: "worktree",
          branch: command.branch,
          worktreePath: command.path,
          associatedWorktreePath: command.path,
          associatedWorktreeBranch: command.branch,
          associatedWorktreeRef: command.headRef,
          createBranchFlowCompleted: true,
          isPinned: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          sidechatSourceThreadId: null,
          lastKnownPr: command.lastKnownPr ?? null,
          handoff: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      return [workspaceEvent, threadEvent];
    }

    case "workspace.conversation.create": {
      const workspace = yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      if (workspace.state === "archiving" || workspace.state === "archived") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workspace '${workspace.id}' cannot add conversations while ${workspace.state}.`,
        });
      }
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: workspace.projectId,
          workspaceId: workspace.id,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          envMode: workspace.kind === "repository-root" ? "local" : "worktree",
          branch: workspace.branch,
          worktreePath: workspace.path,
          associatedWorktreePath: workspace.path,
          associatedWorktreeBranch: workspace.branch,
          associatedWorktreeRef: workspace.headRef,
          createBranchFlowCompleted: workspace.state === "ready",
          isPinned: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          sidechatSourceThreadId: null,
          lastKnownPr: workspace.lastKnownPr,
          handoff: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "workspace.meta.update": {
      const workspace = yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      if (
        command.title === undefined &&
        command.branch === undefined &&
        command.targetRef === undefined &&
        command.lastKnownPr === undefined &&
        command.isPinned === undefined
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workspace metadata update for '${workspace.id}' did not include any changes.`,
        });
      }
      if (
        (command.branch !== undefined || command.targetRef !== undefined) &&
        workspace.state !== "ready"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workspace '${workspace.id}' cannot change git refs while ${workspace.state}.`,
        });
      }
      if (command.lastKnownPr) {
        const existingPrWorkspace = findReservedWorkspaceForPullRequest({
          readModel,
          projectId: workspace.projectId,
          pullRequest: command.lastKnownPr,
          excludeWorkspaceId: workspace.id,
        });
        if (existingPrWorkspace) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: duplicatePullRequestWorkspaceDetail(command.lastKnownPr, existingPrWorkspace),
          });
        }
      }
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        }),
        type: "workspace.meta-updated",
        payload: {
          workspaceId: command.workspaceId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.targetRef !== undefined ? { targetRef: command.targetRef } : {}),
          ...(command.lastKnownPr !== undefined ? { lastKnownPr: command.lastKnownPr } : {}),
          ...(command.isPinned !== undefined ? { isPinned: command.isPinned } : {}),
          mutationRevision: workspace.mutationRevision + 1,
          updatedAt: command.updatedAt,
        },
      };
    }

    case "workspace.import-legacy": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      yield* requireWorkspaceAbsent({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workspace.created",
        payload: {
          workspaceId: command.workspaceId,
          projectId: command.projectId,
          repositoryIdentity: command.repositoryIdentity,
          kind: command.kind,
          state: command.state,
          title: command.title,
          path: command.path,
          branch: command.branch,
          headRef: command.headRef,
          targetRef: command.targetRef,
          targetResolvedCommit: command.targetResolvedCommit,
          createdFromCommit: command.createdFromCommit,
          sourceKind: "imported",
          sourceRef: command.headRef,
          setupStatus: command.setupStatus,
          setupError: null,
          setupLogId: null,
          lastKnownPr: null,
          isPinned: false,
          lifecycleGeneration: 0,
          activeOperation: null,
          lastFailure: null,
          mutationRevision: 0,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
          archivedAt: command.state === "archived" ? command.createdAt : null,
          deletedAt: null,
        },
      };
    }

    case "workspace.provision.request": {
      const workspace = yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      if (
        workspace.kind !== "managed" ||
        workspace.sourceKind !== "pull-request" ||
        (workspace.state !== "error" && workspace.state !== "setup-failed") ||
        workspace.activeOperation !== null
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workspace '${workspace.id}' cannot retry pull request provisioning while ${workspace.state}.`,
        });
      }
      if (workspace.lifecycleGeneration !== command.expectedGeneration) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Stale provision request for workspace '${workspace.id}' was rejected.`,
        });
      }
      const generation = workspace.lifecycleGeneration + 1;
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: workspace.id,
          occurredAt: command.requestedAt,
          commandId: command.commandId,
        }),
        type: "workspace.provision-requested",
        payload: {
          workspaceId: workspace.id,
          operationId: command.operationId,
          generation,
          requestedAt: command.requestedAt,
        },
      };
    }

    case "workspace.archive.request": {
      const workspace = yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      if (workspace.kind === "repository-root") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Repository root workspace '${workspace.id}' cannot be archived.`,
        });
      }
      if (workspace.state !== "ready" || workspace.activeOperation !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workspace '${workspace.id}' cannot be archived while ${workspace.state}.`,
        });
      }
      if (workspace.lifecycleGeneration !== command.expectedGeneration) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Stale archive request for workspace '${workspace.id}' was rejected.`,
        });
      }
      const generation = workspace.lifecycleGeneration + 1;
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: workspace.id,
          occurredAt: command.requestedAt,
          commandId: command.commandId,
        }),
        type: "workspace.archive-requested",
        payload: {
          workspaceId: workspace.id,
          operationId: command.operationId,
          generation,
          confirmedWarnings: command.confirmedWarnings,
          requestedAt: command.requestedAt,
        },
      };
    }

    case "workspace.restore.request": {
      const workspace = yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      if (workspace.kind === "repository-root") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Repository root workspace '${workspace.id}' cannot be restored.`,
        });
      }
      if (workspace.state !== "archived" || workspace.activeOperation !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workspace '${workspace.id}' cannot be restored while ${workspace.state}.`,
        });
      }
      if (workspace.lifecycleGeneration !== command.expectedGeneration) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Stale restore request for workspace '${workspace.id}' was rejected.`,
        });
      }
      const generation = workspace.lifecycleGeneration + 1;
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: workspace.id,
          occurredAt: command.requestedAt,
          commandId: command.commandId,
        }),
        type: "workspace.restore-requested",
        payload: {
          workspaceId: workspace.id,
          operationId: command.operationId,
          generation,
          requestedAt: command.requestedAt,
        },
      };
    }

    case "thread.workspace.assign": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const workspace = yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      if (thread.projectId !== workspace.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${thread.id}' and workspace '${workspace.id}' belong to different projects.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        }),
        type: "thread.workspace-assigned",
        payload: {
          threadId: command.threadId,
          workspaceId: command.workspaceId,
          projectId: workspace.projectId,
          envMode: workspace.kind === "repository-root" ? "local" : "worktree",
          branch: workspace.branch,
          worktreePath: workspace.path,
          updatedAt: command.updatedAt,
        },
      };
    }

    case "workspace.provision.complete": {
      const workspace = yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      if (
        workspace.activeOperation?.id !== command.operationId ||
        workspace.activeOperation.generation !== command.generation
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Stale workspace completion for '${workspace.id}' was rejected.`,
        });
      }
      if (workspace.sourceKind === "pull-request") {
        if (!command.lastKnownPr || !command.targetRef) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Pull-request workspace '${workspace.id}' completion requires refreshed pull request metadata.`,
          });
        }
        if (!workspaceReferencesPullRequest(workspace, command.lastKnownPr)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Pull request #${command.lastKnownPr.number} does not match workspace '${workspace.id}'.`,
          });
        }
        if (command.targetRef !== command.lastKnownPr.baseBranch) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "The resolved pull request base does not match the completion target ref.",
          });
        }
      }

      const readyEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.completedAt,
          commandId: command.commandId,
        }),
        type: "workspace.ready",
        payload: {
          workspaceId: command.workspaceId,
          operationId: command.operationId,
          generation: command.generation,
          path: command.path,
          branch: command.branch,
          headRef: command.headRef,
          targetResolvedCommit: command.targetResolvedCommit,
          createdFromCommit: command.createdFromCommit,
          setupStatus: command.setupStatus,
          completedAt: command.completedAt,
        },
      };
      if (workspace.sourceKind !== "pull-request") {
        return readyEvent;
      }
      const lastKnownPr = command.lastKnownPr!;
      const metadataEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.completedAt,
          commandId: command.commandId,
        }),
        type: "workspace.meta-updated",
        payload: {
          workspaceId: command.workspaceId,
          targetRef: lastKnownPr.baseBranch,
          lastKnownPr,
          mutationRevision: workspace.mutationRevision + 1,
          updatedAt: command.completedAt,
        },
      };
      return [readyEvent, metadataEvent];
    }

    case "workspace.archive.complete": {
      const workspace = yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      if (
        workspace.state !== "archiving" ||
        workspace.activeOperation?.kind !== "archive" ||
        workspace.activeOperation.id !== command.operationId ||
        workspace.activeOperation.generation !== command.generation
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Stale archive completion for '${workspace.id}' was rejected.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: workspace.id,
          occurredAt: command.completedAt,
          commandId: command.commandId,
        }),
        type: "workspace.archived",
        payload: {
          workspaceId: workspace.id,
          operationId: command.operationId,
          generation: command.generation,
          archivedAt: command.completedAt,
        },
      };
    }

    case "workspace.restore.complete": {
      const workspace = yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      if (
        workspace.state !== "provisioning" ||
        workspace.activeOperation?.kind !== "restore" ||
        workspace.activeOperation.id !== command.operationId ||
        workspace.activeOperation.generation !== command.generation
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Stale restore completion for '${workspace.id}' was rejected.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: workspace.id,
          occurredAt: command.completedAt,
          commandId: command.commandId,
        }),
        type: "workspace.restored",
        payload: {
          workspaceId: workspace.id,
          operationId: command.operationId,
          generation: command.generation,
          path: command.path,
          branch: command.branch,
          headRef: command.headRef,
          setupStatus: command.setupStatus,
          completedAt: command.completedAt,
        },
      };
    }

    case "workspace.operation.fail": {
      const workspace = yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      if (
        workspace.activeOperation?.id !== command.operationId ||
        workspace.activeOperation.generation !== command.generation
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Stale workspace failure for '${workspace.id}' was rejected.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.failedAt,
          commandId: command.commandId,
        }),
        type: "workspace.operation-failed",
        payload: {
          workspaceId: command.workspaceId,
          operationId: command.operationId,
          generation: command.generation,
          kind: command.kind,
          stage: command.stage,
          summary: command.summary,
          logId: command.logId ?? null,
          path: command.path ?? null,
          branch: command.branch ?? null,
          headRef: command.headRef ?? null,
          targetResolvedCommit: command.targetResolvedCommit ?? null,
          createdFromCommit: command.createdFromCommit ?? null,
          failedAt: command.failedAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.workspaceId != null) {
        const workspace = yield* requireWorkspace({
          readModel,
          command,
          workspaceId: command.workspaceId,
        });
        if (workspace.projectId !== command.projectId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Thread and workspace project IDs must match.`,
          });
        }
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          workspaceId: command.workspaceId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          envMode: command.envMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          ...deriveCommandAssociatedWorktreeMetadata({
            branch: command.branch,
            worktreePath: command.worktreePath,
            ...(command.associatedWorktreePath !== undefined
              ? { associatedWorktreePath: command.associatedWorktreePath }
              : {}),
            ...(command.associatedWorktreeBranch !== undefined
              ? { associatedWorktreeBranch: command.associatedWorktreeBranch }
              : {}),
            ...(command.associatedWorktreeRef !== undefined
              ? { associatedWorktreeRef: command.associatedWorktreeRef }
              : {}),
          }),
          createBranchFlowCompleted: command.createBranchFlowCompleted,
          isPinned: command.isPinned,
          parentThreadId: command.parentThreadId,
          subagentAgentId: command.subagentAgentId,
          subagentNickname: command.subagentNickname,
          subagentRole: command.subagentRole,
          forkSourceThreadId: null,
          lastKnownPr: command.lastKnownPr,
          handoff: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.handoff.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });

      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      if (sourceThread.projectId !== command.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Source thread '${command.sourceThreadId}' belongs to a different project.`,
        });
      }
      if (sourceThread.handoff !== null && !hasNativeHandoffMessages(sourceThread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Source thread '${command.sourceThreadId}' must contain at least one native chat message after handoff before it can be handed off again.`,
        });
      }
      const workspaceId = command.workspaceId ?? sourceThread.workspaceId ?? null;
      if (workspaceId !== null) {
        const workspace = yield* requireWorkspace({ readModel, command, workspaceId });
        if (workspace.projectId !== command.projectId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Handoff workspace belongs to a different project.`,
          });
        }
      }

      const createdEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          workspaceId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          envMode: command.envMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          ...deriveCommandAssociatedWorktreeMetadata({
            branch: command.branch,
            worktreePath: command.worktreePath,
            ...(command.associatedWorktreePath !== undefined
              ? { associatedWorktreePath: command.associatedWorktreePath }
              : {}),
            ...(command.associatedWorktreeBranch !== undefined
              ? { associatedWorktreeBranch: command.associatedWorktreeBranch }
              : {}),
            ...(command.associatedWorktreeRef !== undefined
              ? { associatedWorktreeRef: command.associatedWorktreeRef }
              : {}),
          }),
          createBranchFlowCompleted: command.createBranchFlowCompleted,
          isPinned: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          handoff: {
            sourceThreadId: command.sourceThreadId,
            sourceProvider: sourceThread.modelSelection.provider,
            importedAt: command.createdAt,
            bootstrapStatus: "pending",
          },
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };

      const importedMessageEvents: ReadonlyArray<Omit<OrchestrationEvent, "sequence">> =
        command.importedMessages.map((message) => ({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            turnId: null,
            streaming: false,
            source: "handoff-import",
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          },
        }));

      return [createdEvent, ...importedMessageEvents];
    }

    case "thread.fork.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });

      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      if (sourceThread.projectId !== command.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Source thread '${command.sourceThreadId}' belongs to a different project.`,
        });
      }
      const workspaceId = command.workspaceId ?? sourceThread.workspaceId ?? null;
      if (workspaceId !== null) {
        const workspace = yield* requireWorkspace({ readModel, command, workspaceId });
        if (workspace.projectId !== command.projectId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Fork workspace belongs to a different project.`,
          });
        }
      }

      const createdEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          workspaceId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          envMode: command.envMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          ...deriveCommandAssociatedWorktreeMetadata({
            branch: command.branch,
            worktreePath: command.worktreePath,
            ...(command.associatedWorktreePath !== undefined
              ? { associatedWorktreePath: command.associatedWorktreePath }
              : {}),
            ...(command.associatedWorktreeBranch !== undefined
              ? { associatedWorktreeBranch: command.associatedWorktreeBranch }
              : {}),
            ...(command.associatedWorktreeRef !== undefined
              ? { associatedWorktreeRef: command.associatedWorktreeRef }
              : {}),
          }),
          createBranchFlowCompleted: command.createBranchFlowCompleted,
          isPinned: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: command.sourceThreadId,
          sidechatSourceThreadId: command.sidechatSourceThreadId,
          handoff: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };

      const importedMessageEvents: ReadonlyArray<Omit<OrchestrationEvent, "sequence">> =
        command.importedMessages.map((message) => ({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            turnId: null,
            streaming: false,
            source: "fork-import",
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          },
        }));

      return [createdEvent, ...importedMessageEvents];
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.envMode !== undefined ? { envMode: command.envMode } : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...deriveCommandAssociatedWorktreeMetadataPatch({
            ...(command.branch !== undefined ? { branch: command.branch } : {}),
            ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
            ...(command.associatedWorktreePath !== undefined
              ? { associatedWorktreePath: command.associatedWorktreePath }
              : {}),
            ...(command.associatedWorktreeBranch !== undefined
              ? { associatedWorktreeBranch: command.associatedWorktreeBranch }
              : {}),
            ...(command.associatedWorktreeRef !== undefined
              ? { associatedWorktreeRef: command.associatedWorktreeRef }
              : {}),
          }),
          ...(command.createBranchFlowCompleted !== undefined
            ? { createBranchFlowCompleted: command.createBranchFlowCompleted }
            : {}),
          ...(command.isPinned !== undefined ? { isPinned: command.isPinned } : {}),
          ...(command.parentThreadId !== undefined
            ? { parentThreadId: command.parentThreadId }
            : {}),
          ...(command.subagentAgentId !== undefined
            ? { subagentAgentId: command.subagentAgentId }
            : {}),
          ...(command.subagentNickname !== undefined
            ? { subagentNickname: command.subagentNickname }
            : {}),
          ...(command.subagentRole !== undefined ? { subagentRole: command.subagentRole } : {}),
          ...(command.handoff !== undefined ? { handoff: command.handoff } : {}),
          ...(command.lastKnownPr !== undefined ? { lastKnownPr: command.lastKnownPr } : {}),
          ...(command.pinnedMessages !== undefined
            ? { pinnedMessages: command.pinnedMessages }
            : {}),
          ...(command.notes !== undefined ? { notes: command.notes } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.add": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingPin = thread.pinnedMessages?.find((pin) => pin.messageId === command.messageId);
      if (!existingPin && (thread.pinnedMessages?.length ?? 0) >= PINNED_MESSAGES_MAX_COUNT) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has the maximum of ${PINNED_MESSAGES_MAX_COUNT} pinned messages.`,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-added",
        payload: {
          threadId: command.threadId,
          pin: existingPin ?? {
            messageId: command.messageId,
            label: null,
            done: false,
            pinnedAt: occurredAt,
          },
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.remove": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-removed",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.done.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-done-set",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          done: command.done,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.label.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-label-set",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          label: command.label,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.marker.add": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.endOffset <= command.startOffset) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Marker end offset must be greater than start offset.`,
        });
      }
      let existingMarker: ThreadMarker | undefined = undefined;
      let replacedMarkerCount = 0;
      for (const marker of thread.threadMarkers ?? []) {
        if (
          marker.id === command.markerId ||
          (marker.messageId === command.messageId &&
            marker.startOffset === command.startOffset &&
            marker.endOffset === command.endOffset &&
            marker.style === command.style)
        ) {
          existingMarker = marker;
        }
        if (
          doThreadMarkerRangesOverlap(marker, {
            messageId: command.messageId,
            startOffset: command.startOffset,
            endOffset: command.endOffset,
          })
        ) {
          replacedMarkerCount += 1;
        }
      }
      if (
        !existingMarker &&
        (thread.threadMarkers?.length ?? 0) - replacedMarkerCount >= THREAD_MARKERS_MAX_COUNT
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has the maximum of ${THREAD_MARKERS_MAX_COUNT} markers.`,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.marker-added",
        payload: {
          threadId: command.threadId,
          marker: existingMarker ?? {
            id: command.markerId,
            messageId: command.messageId,
            startOffset: command.startOffset,
            endOffset: command.endOffset,
            selectedText: command.selectedText,
            style: command.style,
            color: command.color,
            label: null,
            done: false,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          },
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.marker.remove": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.marker-removed",
        payload: {
          threadId: command.threadId,
          markerId: command.markerId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.marker.done.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.marker-done-set",
        payload: {
          threadId: command.threadId,
          markerId: command.markerId,
          done: command.done,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.marker.label.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.marker-label-set",
        payload: {
          threadId: command.threadId,
          markerId: command.markerId,
          label: command.label,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (targetThread.workspaceId != null) {
        const workspace = yield* requireWorkspace({
          readModel,
          command,
          workspaceId: targetThread.workspaceId,
        });
        if (workspace.state !== "ready") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Workspace '${workspace.id}' is ${workspace.state}; provider turns require a ready workspace.`,
          });
        }
      }
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      const dispatchMode = command.dispatchMode ?? "queue";
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          ...(command.message.skills !== undefined ? { skills: command.message.skills } : {}),
          ...(command.message.mentions !== undefined ? { mentions: command.message.mentions } : {}),
          dispatchMode,
          ...(command.dispatchOrigin !== undefined
            ? { dispatchOrigin: command.dispatchOrigin }
            : {}),
          turnId: null,
          streaming: false,
          source: "native",
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnRequestPayload = {
        threadId: command.threadId,
        messageId: command.message.messageId,
        ...(command.modelSelection !== undefined ? { modelSelection: command.modelSelection } : {}),
        ...(command.providerOptions !== undefined
          ? { providerOptions: command.providerOptions }
          : {}),
        ...(command.reviewTarget !== undefined ? { reviewTarget: command.reviewTarget } : {}),
        assistantDeliveryMode: command.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
        dispatchMode,
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
        createdAt: command.createdAt,
      } as const;
      const activeProvider =
        targetThread.session?.providerName ?? targetThread.modelSelection.provider;
      const isThreadRunning =
        targetThread.session?.status === "running" && targetThread.session.activeTurnId !== null;
      // Subagent threads never queue: their messages steer the running child task
      // through the parent session, so deferring until the turn settles would
      // deliver the message only after the subagent already finished.
      const shouldQueue =
        targetThread.parentThreadId === null &&
        isThreadRunning &&
        (dispatchMode === "queue" || activeProvider !== "codex");
      const queuedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: shouldQueue ? "thread.turn-queued" : "thread.turn-start-requested",
        payload: turnRequestPayload,
      };
      if (shouldQueue && dispatchMode === "steer") {
        return [
          userMessageEvent,
          queuedEvent,
          {
            ...withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            }),
            causationEventId: queuedEvent.eventId,
            type: "thread.turn-interrupt-requested",
            payload: {
              threadId: command.threadId,
              turnId: targetThread.session?.activeTurnId ?? undefined,
              createdAt: command.createdAt,
            },
          },
        ];
      }
      return [userMessageEvent, queuedEvent];
    }

    case "thread.turn.dispatch-queued": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.providerOptions !== undefined
            ? { providerOptions: command.providerOptions }
            : {}),
          ...(command.reviewTarget !== undefined ? { reviewTarget: command.reviewTarget } : {}),
          assistantDeliveryMode: command.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
          dispatchMode: command.dispatchMode ?? "queue",
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          ...(command.sourceProposedPlan !== undefined
            ? { sourceProposedPlan: command.sourceProposedPlan }
            : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.task.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.task-stop-requested",
        payload: {
          threadId: command.threadId,
          taskId: command.taskId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.task.background": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.task-background-requested",
        payload: {
          threadId: command.threadId,
          toolUseId: command.toolUseId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          ...(command.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: command.lifecycleGeneration }
            : {}),
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const answers = omitNullUserInputAnswers(command);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          ...(command.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: command.lifecycleGeneration }
            : {}),
          answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          scope: command.scope ?? "thread",
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.conversation.rollback": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const rollbackTarget = deriveConversationRollbackTarget(thread.messages, command.messageId);
      if (!rollbackTarget || rollbackTarget.role !== "user") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Conversation rollback must target an existing user message.",
        });
      }
      if (command.numTurns <= 0 || rollbackTarget.removedTurnIds.size !== command.numTurns) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Conversation rollback requested ${command.numTurns} turn(s), but target message '${command.messageId}' would remove ${rollbackTarget.removedTurnIds.size} turn(s).`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.conversation-rollback-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          numTurns: command.numTurns,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.message.edit-and-resend": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const editTarget = resolveTailUserMessageEditTarget({
        messages: thread.messages,
        messageId: command.messageId,
        activeTurnId:
          thread.session?.status === "running" ? (thread.session.activeTurnId ?? null) : null,
      });
      if (!editTarget.editable) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Only the latest rollbackable user message can be edited and resent (${editTarget.reason}).`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-edit-resend-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          text: command.text,
          rollbackTurnCount: editTarget.rollbackTurnCount,
          removedTurnIds: editTarget.removedTurnIds.map((turnId) => TurnId.makeUnsafe(turnId)),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.providerOptions !== undefined
            ? { providerOptions: command.providerOptions }
            : {}),
          ...(command.assistantDeliveryMode !== undefined
            ? { assistantDeliveryMode: command.assistantDeliveryMode }
            : {}),
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.messages.import": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return command.messages.map((message) => ({
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent" as const,
        payload: {
          threadId: command.threadId,
          messageId: message.messageId,
          role: message.role,
          text: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          turnId: null,
          streaming: false,
          source: "native" as const,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        },
      }));
    }

    case "thread.message.assistant.delta": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingMessage = thread.messages.find((message) => message.id === command.messageId);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: resolveStableMessageTurnId({
            existingTurnId: existingMessage?.turnId,
            incomingTurnId: command.turnId,
          }),
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingMessage = thread.messages.find((message) => message.id === command.messageId);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: existingMessage?.text ?? "",
          turnId: resolveStableMessageTurnId({
            existingTurnId: existingMessage?.turnId,
            incomingTurnId: command.turnId,
          }),
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
          ...(command.preserveLatestTurn ? { preserveLatestTurn: true } : {}),
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.conversation.rollback.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.conversation-rolled-back",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          numTurns: command.numTurns,
          ...(command.removedTurnIds !== undefined
            ? { removedTurnIds: command.removedTurnIds }
            : {}),
          ...(command.skipAttachmentPrune !== undefined
            ? { skipAttachmentPrune: command.skipAttachmentPrune }
            : {}),
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
