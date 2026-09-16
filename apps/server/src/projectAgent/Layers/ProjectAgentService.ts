import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  AutomationId,
  CommandId,
  DEFAULT_PROJECT_AGENT_LIMITS,
  PROJECT_AGENT_INITIAL_SUMMARY_THREAD_COUNT,
  ProjectActivityId,
  ProjectAgentConfig,
  ProjectDocumentRevisionId,
  ProjectEvidenceId,
  ProjectGoal,
  ProjectGoalId,
  ProjectId,
  ProjectInboxEventId,
  ProjectTask,
  ProjectTaskAttemptId,
  ProjectTaskId,
  ThreadId,
  type OrchestrationCommand,
  type ProjectActivity,
  type ProjectAgentOverview,
  type ProjectAgentStreamEvent,
  type ProjectDocumentRevision,
  type ProjectTaskStatus,
} from "@synara/contracts";
import { isOrdinaryProjectRow } from "@synara/shared/projectContainers";
import {
  decodeProjectAgentListCursor,
  detectProjectTaskDependencyCycle,
  encodeProjectAgentListCursor,
  isCoordinatorCuratedDocumentPath,
  isGeneratedDocumentPath,
  isInboxDocumentPath,
  isUserOwnedDocumentPath,
  normalizeProjectDocumentPath,
  truncateToContextBudget,
} from "@synara/shared/projectAgent";
import { Effect, Layer, Option, PubSub, Stream } from "effect";

import { AutomationService } from "../../automation/Services/AutomationService.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectAgentServiceError } from "../Errors.ts";
import {
  hashDocumentContent,
  readProjectDocumentMirror,
  writeProjectDocumentMirror,
} from "../materializer.ts";
import {
  canAcceptTask,
  canConfigureProject,
  canStartGoal,
  isCoordinatorPrincipal,
  isUserPrincipal,
  type ProjectAgentPrincipal,
} from "../principal.ts";
import { ProjectAgentService, type ProjectAgentServiceShape } from "../Services/ProjectAgentService.ts";

const fail = (message: string, code?: ProjectAgentServiceError["code"]) =>
  new ProjectAgentServiceError({ message, ...(code ? { code } : {}) });

const isoNow = () => new Date().toISOString();
const branded = {
  thread: (id = randomUUID()) => ThreadId.makeUnsafe(id),
  command: (id = randomUUID()) => CommandId.makeUnsafe(id),
  goal: (id = randomUUID()) => ProjectGoalId.makeUnsafe(id),
  task: (id = randomUUID()) => ProjectTaskId.makeUnsafe(id),
  attempt: (id = randomUUID()) => ProjectTaskAttemptId.makeUnsafe(id),
  evidence: (id = randomUUID()) => ProjectEvidenceId.makeUnsafe(id),
  document: (id = randomUUID()) => ProjectDocumentRevisionId.makeUnsafe(id),
  activity: (id = randomUUID()) => ProjectActivityId.makeUnsafe(id),
  inbox: (id = randomUUID()) => ProjectInboxEventId.makeUnsafe(id),
  automation: (id = randomUUID()) => AutomationId.makeUnsafe(id),
};

const SEED_DOCUMENTS: ReadonlyArray<{ path: string; content: string }> = [
  { path: "overview.md", content: "# Overview\n\nCoordinator is not configured.\n" },
  { path: "instructions.md", content: "# Instructions\n\n" },
  { path: "notes.md", content: "# Notes\n\n" },
  { path: "decisions.md", content: "# Decisions\n\n" },
  { path: "archived.md", content: "# Archived\n\n" },
  { path: "artifacts/index.md", content: "# Artifacts\n\n" },
  { path: "internal/manifest.json", content: "{}\n" },
];

export const makeProjectAgentService = Effect.gen(function* () {
  const repository = yield* ProjectAgentRepository;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionThreads = yield* ProjectionThreadRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const automationService = yield* AutomationService;
  const serverConfig = yield* ServerConfig;
  const events = yield* PubSub.unbounded<ProjectAgentStreamEvent>();

  const publish = (event: ProjectAgentStreamEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const toServiceError = (message: string) => (cause: unknown) =>
    new ProjectAgentServiceError({
      message: cause instanceof Error && cause.message.includes("revision mismatch")
        ? "This project record changed. Reload and retry with the latest revision."
        : message,
      code: cause instanceof Error && cause.message.includes("revision mismatch") ? "conflict" : "invalid",
      cause,
    });

  const requireOrdinaryProject = (projectId: ProjectId) =>
    snapshotQuery.getProjectShellById(projectId).pipe(
      Effect.mapError(toServiceError("Failed to load project.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail(`Project "${projectId}" was not found.`, "not-found")),
          onSome: (project) => {
            const ordinary = isOrdinaryProjectRow({
              projectTitle: project.title,
              projectWorkspaceRoot: project.workspaceRoot,
              projectKind: project.kind,
              paths: {
                homeDir: serverConfig.homeDir,
                chatWorkspaceRoot: serverConfig.chatWorkspaceRoot,
              },
            });
            return ordinary
              ? Effect.succeed(project)
              : Effect.fail(fail("Project Coordinator is only available on ordinary projects.", "forbidden"));
          },
        }),
      ),
    );

  const requireConfig = (projectId: ProjectId) =>
    repository.getConfig(projectId).pipe(
      Effect.mapError(toServiceError("Failed to load project coordinator.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail("Project Coordinator is not configured.", "unconfigured")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const appendActivity = (input: Omit<ProjectActivity, "id" | "sequence">) =>
    Effect.gen(function* () {
      const sequence = yield* repository
        .nextActivitySequence(input.projectId)
        .pipe(Effect.mapError(toServiceError("Failed to allocate activity sequence.")));
      const activity: ProjectActivity = {
        ...input,
        id: branded.activity(),
        sequence,
      };
      const saved = yield* repository
        .appendActivity(activity)
        .pipe(Effect.mapError(toServiceError("Failed to record project activity.")));
      yield* publish({ type: "activity-appended", activity: saved });
      return saved;
    });

  const writeSeedDocument = (
    projectId: ProjectId,
    logicalPath: string,
    content: string,
    authorKind: ProjectDocumentRevision["authorKind"],
  ) =>
    Effect.gen(function* () {
      const now = isoNow();
      const revision: ProjectDocumentRevision = {
        id: branded.document(),
        projectId,
        logicalPath: normalizeProjectDocumentPath(logicalPath),
        revision: 1,
        content,
        contentHash: hashDocumentContent(content),
        authorKind,
        authorThreadId: null,
        sources: [],
        createdAt: now,
      };
      const saved = yield* repository
        .writeDocument({ revision, expectedRevision: null, diskHash: revision.contentHash })
        .pipe(Effect.mapError(toServiceError("Failed to write project document.")));
      yield* writeProjectDocumentMirror({
        stateDir: serverConfig.stateDir,
        projectId,
        logicalPath,
        content,
      }).pipe(Effect.mapError(toServiceError("Failed to materialize project document.")));
      return saved;
    });

  const indexProjectThreads = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const threads = yield* projectionThreads
        .listByProjectId({ projectId })
        .pipe(Effect.mapError(toServiceError("Failed to index project threads.")));
      const persistent = threads.filter((thread) => thread.deletedAt === null);
      const sorted = [...persistent].toSorted((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
      let index = 0;
      for (const thread of sorted) {
        const covered = index < PROJECT_AGENT_INITIAL_SUMMARY_THREAD_COUNT;
        yield* repository
          .upsertThreadIndex({
            projectId,
            threadId: thread.threadId,
            excluded: false,
            archived: thread.archivedAt !== null,
            summaryStatus: covered ? "covered" : "pending",
            lastUpdatedAt: thread.updatedAt,
            lastSummarizedAt: covered ? isoNow() : null,
          })
          .pipe(Effect.mapError(toServiceError("Failed to store thread index.")));
        index += 1;
      }
      return {
        summarizedThreadCount: Math.min(sorted.length, PROJECT_AGENT_INITIAL_SUMMARY_THREAD_COUNT),
        pendingThreadCount: Math.max(0, sorted.length - PROJECT_AGENT_INITIAL_SUMMARY_THREAD_COUNT),
      };
    });

  const buildOverview = (projectId: ProjectId): Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError> =>
    Effect.gen(function* () {
      const config = yield* repository
        .getConfig(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load project coordinator.")));
      if (Option.isNone(config)) {
        return {
          projectId,
          configured: false,
          config: null,
          goal: null,
          digest: null,
          blockers: [],
          recentOutcomes: [],
          coordinatorStatus: "unconfigured",
        };
      }
      const goal = yield* repository
        .getActiveGoal(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load project goal.")));
      const digest = yield* repository
        .getDigest(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load project digest.")));
      const tasks = yield* repository
        .listTasks({ projectId, includeArchived: false, limit: 100 })
        .pipe(Effect.mapError(toServiceError("Failed to load project tasks.")));
      const activity = yield* repository
        .listActivity({ projectId, limit: 8 })
        .pipe(Effect.mapError(toServiceError("Failed to load project activity.")));
      const blockers = tasks
        .filter((task) => task.status === "blocked")
        .map((task) => ({
          taskId: task.id,
          title: task.title,
          reason: task.acceptanceCriteria ?? "Blocked",
        }));
      const goalValue = Option.getOrNull(goal);
      const coordinatorStatus =
        goalValue?.status === "paused"
          ? "paused"
          : goalValue?.status === "stopped"
            ? "stopped"
            : goalValue?.status === "active"
              ? "running"
              : "idle";
      return {
        projectId,
        configured: true,
        config: config.value,
        goal: goalValue,
        digest: Option.getOrNull(digest),
        blockers,
        recentOutcomes: activity,
        coordinatorStatus,
      };
    });

  const replayReceipt = <A>(requestId: string, decode: (json: string) => A) =>
    repository.getReceipt(requestId).pipe(
      Effect.mapError(toServiceError("Failed to load request receipt.")),
      Effect.map((option) => (Option.isSome(option) ? decode(option.value.resultJson) : null)),
    );

  const storeReceipt = (requestId: string, projectId: ProjectId, operation: string, result: unknown) =>
    repository
      .saveReceipt({
        requestId,
        projectId,
        operation,
        resultJson: JSON.stringify(result),
        createdAt: isoNow(),
      })
      .pipe(Effect.mapError(toServiceError("Failed to persist request receipt.")));

  const createCoordinatorThread = (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ProjectAgentConfig["coordinatorModelSelection"];
  }) =>
    Effect.gen(function* () {
      const threadId = branded.thread();
      const command: OrchestrationCommand = {
        type: "thread.create",
        commandId: branded.command(),
        threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        envMode: "local",
        branch: null,
        worktreePath: null,
        createdAt: isoNow(),
      };
      yield* orchestrationEngine
        .dispatch(command)
        .pipe(Effect.mapError(toServiceError("Failed to create coordinator thread.")));
      return threadId;
    });

  const assertSameProject = (principal: ProjectAgentPrincipal, projectId: ProjectId) => {
    if (principal.kind === "user") return Effect.void;
    if (principal.projectId !== projectId) {
      return Effect.fail(fail("This thread cannot access another project's coordinator.", "forbidden"));
    }
    return Effect.void;
  };

  const impl: ProjectAgentServiceShape = {
    getOverview: (input, principal) =>
      assertSameProject(principal, input.projectId).pipe(
        Effect.andThen(requireOrdinaryProject(input.projectId)),
        Effect.andThen(buildOverview(input.projectId)),
      ),

    configure: (input, principal) =>
      Effect.gen(function* () {
        if (!canConfigureProject(principal)) {
          return yield* Effect.fail(fail("Only the user can configure Project Coordinator.", "forbidden"));
        }
        const existingReceipt = yield* replayReceipt(input.requestId, (json) => JSON.parse(json) as ProjectAgentOverview);
        if (existingReceipt) return existingReceipt;
        const project = yield* requireOrdinaryProject(input.projectId);
        const existing = yield* repository
          .getConfig(input.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load project coordinator.")));
        const now = isoNow();
        const coordinatorName = input.coordinatorName ?? `${project.title} Coordinator`;
        let coordinatorThreadId: ThreadId;
        let automationId: ProjectAgentConfig["automationId"] = null;
        let revision = 1;
        if (Option.isSome(existing)) {
          if (input.expectedRevision !== undefined && input.expectedRevision !== existing.value.revision) {
            return yield* Effect.fail(fail("Coordinator settings changed. Reload and retry.", "conflict"));
          }
          coordinatorThreadId = existing.value.coordinatorThreadId;
          automationId = existing.value.automationId;
          revision = existing.value.revision + 1;
        } else {
          coordinatorThreadId = yield* createCoordinatorThread({
            projectId: input.projectId,
            title: coordinatorName,
            modelSelection: input.coordinatorModelSelection,
          });
        }
        const config: ProjectAgentConfig = {
          projectId: input.projectId,
          coordinatorThreadId,
          coordinatorName,
          coordinatorModelSelection: input.coordinatorModelSelection,
          ...(input.coordinatorProviderOptions
            ? { coordinatorProviderOptions: input.coordinatorProviderOptions }
            : {}),
          ...(input.workerRouting ? { workerRouting: input.workerRouting } : {}),
          limits: input.limits,
          captureEnabled: input.captureEnabled,
          enabled: true,
          automationId,
          revision,
          createdAt: Option.isSome(existing) ? existing.value.createdAt : now,
          updatedAt: now,
          disabledAt: null,
        };
        const saved = yield* repository
          .saveConfig(config, Option.isSome(existing) ? existing.value.revision : null)
          .pipe(Effect.mapError(toServiceError("Failed to save coordinator configuration.")));
        if (Option.isNone(existing)) {
          for (const seed of SEED_DOCUMENTS) {
            const content =
              seed.path === "instructions.md" && input.importedInstructions?.trim()
                ? input.importedInstructions
                : seed.content;
            yield* writeSeedDocument(input.projectId, seed.path, content, "system");
          }
          if (input.importedInstructions?.trim()) {
            yield* appendActivity({
              projectId: input.projectId,
              kind: "document-written",
              actorKind: "user",
              actorThreadId: null,
              goalId: null,
              taskId: null,
              source: { path: "instructions.md" },
              summary: "Imported existing project instructions without overwriting newer server content.",
              createdAt: now,
            });
          }
          const coverage = yield* indexProjectThreads(input.projectId);
          yield* repository
            .saveDigest({
              projectId: input.projectId,
              summary: "Coordinator is configured. Start a goal to begin bounded coordination.",
              focusItems: [],
              coverageFromSequence: 0,
              coverageToSequence: 0,
              historicalCoverage: coverage.pendingThreadCount > 0 ? "partial" : "none",
              summarizedThreadCount: coverage.summarizedThreadCount,
              pendingThreadCount: coverage.pendingThreadCount,
              generationState: "idle",
              generatedAt: now,
              lastGoodAt: now,
              lastError: null,
            })
            .pipe(Effect.mapError(toServiceError("Failed to store initial digest.")));
          const automation = yield* automationService
            .createProjectManaged({
              projectId: input.projectId,
              sourceThreadId: coordinatorThreadId,
              name: `${coordinatorName} events`,
              prompt:
                "Continue the assigned project goal using current durable project state. Do not expand scope. Review worker outcomes; never mark a task done from a provider turn.",
              schedule: { type: "project-event", projectId: input.projectId },
              enabled: true,
              modelSelection: input.coordinatorModelSelection,
              mode: "heartbeat",
              targetThreadId: coordinatorThreadId,
              stopOnError: true,
            })
            .pipe(Effect.mapError(toServiceError("Failed to create project-event automation.")));
          const withAutomation: ProjectAgentConfig = {
            ...saved,
            automationId: automation.id,
            revision: saved.revision + 1,
            updatedAt: isoNow(),
          };
          yield* repository
            .saveConfig(withAutomation, saved.revision)
            .pipe(Effect.mapError(toServiceError("Failed to link project automation.")));
        }
        yield* publish({ type: "config-upserted", config: saved });
        yield* appendActivity({
          projectId: input.projectId,
          kind: "config-updated",
          actorKind: "user",
          actorThreadId: null,
          goalId: null,
          taskId: null,
          source: null,
          summary: Option.isSome(existing)
            ? "Updated Project Coordinator settings."
            : "Configured Project Coordinator. Assigned work starts only after a goal is started.",
          createdAt: now,
        });
        const overview = yield* buildOverview(input.projectId);
        yield* storeReceipt(input.requestId, input.projectId, "configure", overview);
        return overview;
      }),

    startGoal: (input, principal) =>
      Effect.gen(function* () {
        if (!canStartGoal(principal)) {
          return yield* Effect.fail(fail("Goal authorization can originate only from a user action.", "forbidden"));
        }
        const existingReceipt = yield* replayReceipt(input.requestId, (json) => JSON.parse(json) as ProjectGoal);
        if (existingReceipt) return existingReceipt;
        yield* requireOrdinaryProject(input.projectId);
        const config = yield* requireConfig(input.projectId);
        const open = yield* repository
          .getActiveGoal(input.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load project goal.")));
        if (Option.isSome(open)) {
          return yield* Effect.fail(fail("This project already has an active or paused goal.", "conflict"));
        }
        const now = isoNow();
        const goal: ProjectGoal = {
          id: branded.goal(),
          projectId: input.projectId,
          objective: input.objective,
          authorizationSource: "user",
          scopeVersion: 1,
          acceptanceCriteria: input.acceptanceCriteria ?? null,
          limits: input.limits ?? config.limits ?? { ...DEFAULT_PROJECT_AGENT_LIMITS },
          status: "active",
          continuationCount: 0,
          workerCreationCount: 0,
          authorizedAt: now,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        const saved = yield* repository
          .saveGoal(goal, null)
          .pipe(Effect.mapError(toServiceError("Failed to start project goal.")));
        yield* publish({ type: "goal-upserted", goal: saved });
        yield* appendActivity({
          projectId: input.projectId,
          kind: "goal-started",
          actorKind: "user",
          actorThreadId: null,
          goalId: saved.id,
          taskId: null,
          source: null,
          summary: `Started goal: ${saved.objective}`,
          createdAt: now,
        });
        yield* storeReceipt(input.requestId, input.projectId, "startGoal", saved);
        return saved;
      }),

    updateGoal: (input, principal) =>
      Effect.gen(function* () {
        if (!isUserPrincipal(principal)) {
          return yield* Effect.fail(fail("Changing authorized goal scope is a user action.", "forbidden"));
        }
        const existingReceipt = yield* replayReceipt(input.requestId, (json) => JSON.parse(json) as ProjectGoal);
        if (existingReceipt) return existingReceipt;
        const current = yield* repository.getGoal(input.goalId).pipe(
          Effect.mapError(toServiceError("Failed to load project goal.")),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(fail("Goal was not found.", "not-found")),
              onSome: Effect.succeed,
            }),
          ),
        );
        if (current.projectId !== input.projectId) {
          return yield* Effect.fail(fail("Goal does not belong to this project.", "forbidden"));
        }
        const updated: ProjectGoal = {
          ...current,
          objective: input.objective ?? current.objective,
          acceptanceCriteria:
            input.acceptanceCriteria === undefined ? current.acceptanceCriteria : input.acceptanceCriteria,
          scopeVersion: input.scopeVersion ?? current.scopeVersion,
          revision: current.revision + 1,
          updatedAt: isoNow(),
        };
        const saved = yield* repository
          .saveGoal(updated, input.expectedRevision)
          .pipe(Effect.mapError(toServiceError("Failed to update project goal.")));
        yield* publish({ type: "goal-upserted", goal: saved });
        yield* appendActivity({
          projectId: input.projectId,
          kind: "goal-updated",
          actorKind: "user",
          actorThreadId: null,
          goalId: saved.id,
          taskId: null,
          source: null,
          summary: "Updated authorized goal scope.",
          createdAt: saved.updatedAt,
        });
        yield* storeReceipt(input.requestId, input.projectId, "updateGoal", saved);
        return saved;
      }),

    pauseGoal: (input, principal) =>
      updateGoalStatus(input, principal, "paused", "goal-paused", "Paused the project goal. Current tasks may settle."),
    resumeGoal: (input, principal) =>
      updateGoalStatus(input, principal, "active", "goal-resumed", "Resumed the project goal."),
    stopGoal: (input, principal) =>
      updateGoalStatus(
        input,
        principal,
        "stopped",
        "goal-stopped",
        "Stopped the project goal. Pending continuations were cancelled.",
      ),

    listTasks: (input, principal) =>
      assertSameProject(principal, input.projectId).pipe(
        Effect.andThen(
          repository
            .listTasks({
              projectId: input.projectId,
              ...(input.goalId ? { goalId: input.goalId } : {}),
              includeArchived: input.includeArchived,
              limit: input.limit,
              ...(decodeProjectAgentListCursor(input.cursor)
                ? { cursor: decodeProjectAgentListCursor(input.cursor)! }
                : {}),
            })
            .pipe(Effect.mapError(toServiceError("Failed to list project tasks."))),
        ),
        Effect.map((tasks) => ({
          tasks,
          nextCursor:
            tasks.length === input.limit
              ? encodeProjectAgentListCursor({
                  createdAt: tasks[tasks.length - 1]!.createdAt,
                  id: tasks[tasks.length - 1]!.id,
                })
              : null,
        })),
      ),

    createTask: (input, principal) =>
      Effect.gen(function* () {
        yield* assertSameProject(principal, input.projectId);
        if (!canAcceptTask(principal, input.projectId) && principal.kind !== "coordinator") {
          return yield* Effect.fail(fail("Workers cannot create tasks.", "forbidden"));
        }
        const existingReceipt = yield* replayReceipt(input.requestId, (json) => JSON.parse(json) as ProjectTask);
        if (existingReceipt) return existingReceipt;
        const goal = yield* repository.getGoal(input.goalId).pipe(
          Effect.mapError(toServiceError("Failed to load project goal.")),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(fail("Goal was not found.", "not-found")),
              onSome: Effect.succeed,
            }),
          ),
        );
        if (goal.projectId !== input.projectId) {
          return yield* Effect.fail(fail("Goal does not belong to this project.", "forbidden"));
        }
        if (goal.status !== "active") {
          return yield* Effect.fail(fail("Tasks can only be created for an active goal.", "invalid"));
        }
        const edges = yield* repository
          .listTaskEdges(input.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load task dependencies.")));
        const taskId = branded.task();
        if (
          detectProjectTaskDependencyCycle({
            taskId,
            dependsOnTaskIds: input.dependsOnTaskIds,
            edges,
          })
        ) {
          return yield* Effect.fail(fail("Task dependencies cannot form a cycle.", "cycle"));
        }
        for (const dependencyId of input.dependsOnTaskIds) {
          const dependency = yield* repository
            .getTask(dependencyId)
            .pipe(Effect.mapError(toServiceError("Failed to load task dependency.")));
          if (Option.isNone(dependency) || dependency.value.projectId !== input.projectId) {
            return yield* Effect.fail(fail("Task dependencies must belong to the same project.", "invalid"));
          }
        }
        const ready =
          input.dependsOnTaskIds.length === 0 ||
          (yield* Effect.forEach(input.dependsOnTaskIds, (id) => repository.getTask(id))).every(
            (option) => Option.isSome(option) && option.value.status === "done",
          );
        const now = isoNow();
        const task: ProjectTask = {
          id: taskId,
          projectId: input.projectId,
          goalId: input.goalId,
          title: input.title,
          description: input.description ?? null,
          acceptanceCriteria: input.acceptanceCriteria ?? null,
          status: ready ? "ready" : "planned",
          dependsOnTaskIds: input.dependsOnTaskIds,
          assignedThreadId: null,
          repairCount: 0,
          archivedAt: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        const saved = yield* repository
          .saveTask(task, null)
          .pipe(Effect.mapError(toServiceError("Failed to create project task.")));
        yield* publish({ type: "task-upserted", task: saved });
        yield* appendActivity({
          projectId: input.projectId,
          kind: "task-created",
          actorKind: principal.kind === "user" ? "user" : "coordinator",
          actorThreadId: principal.kind === "user" ? null : principal.threadId,
          goalId: saved.goalId,
          taskId: saved.id,
          source: null,
          summary: `Created task: ${saved.title}`,
          createdAt: now,
        });
        yield* storeReceipt(input.requestId, input.projectId, "createTask", saved);
        return saved;
      }),

    updateTask: (input, principal) =>
      Effect.gen(function* () {
        yield* assertSameProject(principal, input.projectId);
        const existingReceipt = yield* replayReceipt(input.requestId, (json) => JSON.parse(json) as ProjectTask);
        if (existingReceipt) return existingReceipt;
        const current = yield* repository.getTask(input.taskId).pipe(
          Effect.mapError(toServiceError("Failed to load project task.")),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(fail("Task was not found.", "not-found")),
              onSome: Effect.succeed,
            }),
          ),
        );
        if (current.projectId !== input.projectId) {
          return yield* Effect.fail(fail("Task does not belong to this project.", "forbidden"));
        }
        if (input.accept) {
          if (!canAcceptTask(principal, input.projectId)) {
            return yield* Effect.fail(
              fail("A worker cannot mark a task accepted. Acceptance requires the coordinator or user.", "forbidden"),
            );
          }
          if (current.status !== "review" && current.status !== "ready" && current.status !== "running") {
            return yield* Effect.fail(fail("Only reviewed work can be accepted against recorded evidence.", "invalid"));
          }
          const evidence = yield* repository
            .listEvidenceForTask(current.id)
            .pipe(Effect.mapError(toServiceError("Failed to load task evidence.")));
          if (evidence.length === 0) {
            return yield* Effect.fail(fail("Acceptance requires recorded evidence.", "invalid"));
          }
        }
        if (principal.kind === "worker" && input.status === "done") {
          return yield* Effect.fail(
            fail("A finished provider turn updates an attempt. It cannot mark a task done.", "forbidden"),
          );
        }
        const dependsOnTaskIds = input.dependsOnTaskIds ?? current.dependsOnTaskIds;
        if (input.dependsOnTaskIds) {
          const edges = yield* repository
            .listTaskEdges(input.projectId)
            .pipe(Effect.mapError(toServiceError("Failed to load task dependencies.")));
          if (
            detectProjectTaskDependencyCycle({
              taskId: current.id,
              dependsOnTaskIds,
              edges,
            })
          ) {
            return yield* Effect.fail(fail("Task dependencies cannot form a cycle.", "cycle"));
          }
        }
        const nextStatus: ProjectTaskStatus = input.accept
          ? "done"
          : input.status ?? current.status;
        const updated: ProjectTask = {
          ...current,
          title: input.title ?? current.title,
          description: input.description === undefined ? current.description : input.description,
          acceptanceCriteria:
            input.acceptanceCriteria === undefined ? current.acceptanceCriteria : input.acceptanceCriteria,
          status: nextStatus,
          dependsOnTaskIds,
          archivedAt:
            input.archived === undefined
              ? current.archivedAt
              : input.archived
                ? current.archivedAt ?? isoNow()
                : null,
          revision: current.revision + 1,
          updatedAt: isoNow(),
        };
        const saved = yield* repository
          .saveTask(updated, input.expectedRevision)
          .pipe(Effect.mapError(toServiceError("Failed to update project task.")));
        if (input.accept) {
          yield* unblockDependents(saved);
        }
        yield* publish({ type: "task-upserted", task: saved });
        yield* appendActivity({
          projectId: input.projectId,
          kind: input.accept ? "task-accepted" : "task-updated",
          actorKind: principal.kind === "worker" ? "worker" : principal.kind === "coordinator" ? "coordinator" : "user",
          actorThreadId: principal.kind === "user" ? null : principal.threadId,
          goalId: saved.goalId,
          taskId: saved.id,
          source: null,
          summary: input.accept ? `Accepted task: ${saved.title}` : `Updated task: ${saved.title}`,
          createdAt: saved.updatedAt,
        });
        yield* storeReceipt(input.requestId, input.projectId, "updateTask", saved);
        return saved;
      }),

    listActivity: (input, principal) =>
      assertSameProject(principal, input.projectId).pipe(
        Effect.andThen(
          repository
            .listActivity({
              projectId: input.projectId,
              limit: input.limit,
              ...(decodeProjectAgentListCursor(input.cursor)
                ? { cursor: decodeProjectAgentListCursor(input.cursor)! }
                : {}),
            })
            .pipe(Effect.mapError(toServiceError("Failed to list project activity."))),
        ),
        Effect.map((activity) => ({
          activity,
          nextCursor:
            activity.length === input.limit
              ? encodeProjectAgentListCursor({
                  createdAt: activity[activity.length - 1]!.createdAt,
                  id: activity[activity.length - 1]!.id,
                })
              : null,
        })),
      ),

    listDocuments: (input, principal) =>
      assertSameProject(principal, input.projectId).pipe(
        Effect.andThen(
          repository
            .listDocumentHeads(input.projectId)
            .pipe(Effect.mapError(toServiceError("Failed to list project documents."))),
        ),
        Effect.map((documents) => ({
          documents: input.prefix
            ? documents.filter((doc) => doc.logicalPath.startsWith(input.prefix!))
            : documents,
        })),
      ),

    readDocument: (input, principal) =>
      Effect.gen(function* () {
        yield* assertSameProject(principal, input.projectId);
        const logicalPath = normalizeProjectDocumentPath(input.logicalPath);
        const head = yield* repository.getDocumentHead(input.projectId, logicalPath).pipe(
          Effect.mapError(toServiceError("Failed to load document head.")),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(fail("Document was not found.", "not-found")),
              onSome: Effect.succeed,
            }),
          ),
        );
        const document = yield* repository
          .readDocumentRevision({
            projectId: input.projectId,
            logicalPath,
            ...(input.revision ? { revision: input.revision } : {}),
          })
          .pipe(
            Effect.mapError(toServiceError("Failed to read project document.")),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(fail("Document revision was not found.", "not-found")),
                onSome: Effect.succeed,
              }),
            ),
          );
        const disk = yield* readProjectDocumentMirror({
          stateDir: serverConfig.stateDir,
          projectId: input.projectId,
          logicalPath,
        }).pipe(Effect.catch(() => Effect.succeed(null)));
        const diskHash = disk === null ? null : hashDocumentContent(disk);
        const conflictPending = diskHash !== null && diskHash !== head.contentHash;
        const history = yield* repository
          .listDocumentHistory({ projectId: input.projectId, logicalPath })
          .pipe(Effect.mapError(toServiceError("Failed to load document history.")));
        return {
          head: { ...head, diskHash, conflictPending },
          document,
          history,
        };
      }),

    writeDocument: (input, principal) =>
      Effect.gen(function* () {
        yield* assertSameProject(principal, input.projectId);
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          (json) => JSON.parse(json) as ProjectDocumentRevision,
        );
        if (existingReceipt) return existingReceipt;
        const logicalPath = normalizeProjectDocumentPath(input.logicalPath);
        if (isGeneratedDocumentPath(logicalPath) && principal.kind !== "user") {
          return yield* Effect.fail(fail("Generated views cannot be overwritten directly.", "forbidden"));
        }
        if (logicalPath === "instructions.md" && principal.kind === "worker") {
          return yield* Effect.fail(fail("Workers cannot rewrite user instructions.", "forbidden"));
        }
        if (isInboxDocumentPath(logicalPath) && principal.kind === "worker") {
          const expectedPrefix = `inbox/${principal.threadId}/`;
          if (!logicalPath.startsWith(expectedPrefix)) {
            return yield* Effect.fail(fail("Workers can only write their own inbox entries.", "forbidden"));
          }
        }
        if (
          isCoordinatorCuratedDocumentPath(logicalPath) &&
          principal.kind === "worker"
        ) {
          return yield* Effect.fail(fail("Workers cannot rewrite curated project knowledge.", "forbidden"));
        }
        const head = yield* repository
          .getDocumentHead(input.projectId, logicalPath)
          .pipe(Effect.mapError(toServiceError("Failed to load document head.")));
        const currentRevision = Option.isSome(head) ? head.value.revision : 0;
        if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
          return yield* Effect.fail(fail("Document changed. Reload and retry with the latest revision.", "conflict"));
        }
        const disk = yield* readProjectDocumentMirror({
          stateDir: serverConfig.stateDir,
          projectId: input.projectId,
          logicalPath,
        }).pipe(Effect.catch(() => Effect.succeed(null)));
        const diskHash = disk === null ? null : hashDocumentContent(disk);
        if (
          !input.importExternal &&
          Option.isSome(head) &&
          diskHash !== null &&
          diskHash !== head.value.contentHash
        ) {
          return yield* Effect.fail(
            fail(
              "The Markdown file changed outside Synara. Import the external copy explicitly instead of overwriting it.",
              "conflict",
            ),
          );
        }
        const content = input.importExternal && disk !== null ? disk : input.content;
        const now = isoNow();
        const revision: ProjectDocumentRevision = {
          id: branded.document(),
          projectId: input.projectId,
          logicalPath,
          revision: currentRevision + 1,
          content,
          contentHash: hashDocumentContent(content),
          authorKind: principal.kind === "user" ? "user" : principal.kind === "coordinator" ? "coordinator" : "worker",
          authorThreadId: principal.kind === "user" ? null : principal.threadId,
          sources: input.sources,
          createdAt: now,
        };
        const saved = yield* repository
          .writeDocument({
            revision,
            expectedRevision: currentRevision === 0 ? null : currentRevision,
            diskHash: revision.contentHash,
            conflictPending: false,
          })
          .pipe(Effect.mapError(toServiceError("Failed to write project document.")));
        yield* writeProjectDocumentMirror({
          stateDir: serverConfig.stateDir,
          projectId: input.projectId,
          logicalPath,
          content,
        }).pipe(Effect.mapError(toServiceError("Failed to materialize project document.")));
        yield* publish({
          type: "document-head-updated",
          head: {
            projectId: input.projectId,
            logicalPath,
            revision: saved.revision,
            contentHash: saved.contentHash,
            diskHash: saved.contentHash,
            conflictPending: false,
            updatedAt: now,
          },
        });
        yield* appendActivity({
          projectId: input.projectId,
          kind: "document-written",
          actorKind: revision.authorKind,
          actorThreadId: revision.authorThreadId,
          goalId: null,
          taskId: null,
          source: { path: logicalPath },
          summary: `Wrote ${logicalPath}`,
          createdAt: now,
        });
        yield* storeReceipt(input.requestId, input.projectId, "writeDocument", saved);
        return saved;
      }),

    exportDocuments: (input, principal) =>
      Effect.gen(function* () {
        if (!isUserPrincipal(principal)) {
          return yield* Effect.fail(fail("Exporting project documents is a user action.", "forbidden"));
        }
        if (input.logicalPaths.length > 50) {
          return yield* Effect.fail(fail("Export at most 50 documents at a time.", "invalid"));
        }
        const exportedPaths: string[] = [];
        for (const rawPath of input.logicalPaths) {
          const logicalPath = normalizeProjectDocumentPath(rawPath);
          const document = yield* repository
            .readDocumentRevision({ projectId: input.projectId, logicalPath })
            .pipe(Effect.mapError(toServiceError("Failed to read document for export.")));
          if (Option.isNone(document)) continue;
          const destination = path.resolve(input.destinationDirectory, logicalPath);
          if (!destination.startsWith(path.resolve(input.destinationDirectory))) {
            return yield* Effect.fail(fail("Export destination escaped the chosen directory.", "invalid"));
          }
          yield* Effect.tryPromise({
            try: async () => {
              await fs.mkdir(path.dirname(destination), { recursive: true });
              await fs.writeFile(destination, document.value.content, "utf8");
            },
            catch: (cause) => cause,
          }).pipe(Effect.mapError(toServiceError("Failed to export project document.")));
          exportedPaths.push(destination);
        }
        return { exportedPaths };
      }),

    refreshDigest: (input, principal) =>
      Effect.gen(function* () {
        yield* assertSameProject(principal, input.projectId);
        yield* requireConfig(input.projectId);
        const coverage = yield* indexProjectThreads(input.projectId);
        const activity = yield* repository
          .listActivity({ projectId: input.projectId, limit: 20 })
          .pipe(Effect.mapError(toServiceError("Failed to load digest activity.")));
        const previous = yield* repository
          .getDigest(input.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load digest.")));
        const pinned = Option.isSome(previous)
          ? previous.value.focusItems.filter((item) => item.pinned)
          : [];
        const digest = {
          projectId: input.projectId,
          summary:
            activity[0]?.summary ??
            "No project activity yet. Start a goal to begin bounded coordination.",
          focusItems: pinned,
          coverageFromSequence: Option.isSome(previous) ? previous.value.coverageFromSequence : 0,
          coverageToSequence: activity[0]?.sequence ?? 0,
          historicalCoverage: coverage.pendingThreadCount > 0 ? ("partial" as const) : ("complete" as const),
          summarizedThreadCount: coverage.summarizedThreadCount,
          pendingThreadCount: coverage.pendingThreadCount,
          generationState: "idle" as const,
          generatedAt: isoNow(),
          lastGoodAt: isoNow(),
          lastError: null,
        };
        yield* repository
          .saveDigest(digest)
          .pipe(Effect.mapError(toServiceError("Failed to save digest.")));
        yield* publish({ type: "digest-upserted", digest });
        return yield* buildOverview(input.projectId);
      }),

    reportResult: (input, principal) =>
      Effect.gen(function* () {
        if (principal.kind !== "worker" && principal.kind !== "coordinator" && principal.kind !== "user") {
          return yield* Effect.fail(fail("Unknown principal.", "forbidden"));
        }
        yield* assertSameProject(principal, input.projectId);
        const task = yield* repository.getTask(input.taskId).pipe(
          Effect.mapError(toServiceError("Failed to load project task.")),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(fail("Task was not found.", "not-found")),
              onSome: Effect.succeed,
            }),
          ),
        );
        if (principal.kind === "worker" && principal.taskId !== task.id) {
          return yield* Effect.fail(fail("Workers can only report their own task.", "forbidden"));
        }
        const now = isoNow();
        yield* repository
          .saveEvidence({
            id: branded.evidence(),
            projectId: input.projectId,
            taskId: task.id,
            attemptId: input.attemptId ?? null,
            kind: input.evidenceKind,
            classification: "reported",
            authorKind: principal.kind === "user" ? "user" : principal.kind,
            authorThreadId: principal.kind === "user" ? null : principal.threadId,
            sourceThreadId: principal.kind === "user" ? null : principal.threadId,
            sourceMessageId: null,
            sourceTurnId: null,
            summary: input.summary,
            createdAt: now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to record evidence.")));
        if (task.status === "running") {
          const reviewed: ProjectTask = {
            ...task,
            status: "review",
            revision: task.revision + 1,
            updatedAt: now,
          };
          const saved = yield* repository
            .saveTask(reviewed, task.revision)
            .pipe(Effect.mapError(toServiceError("Failed to move task to review.")));
          yield* publish({ type: "task-upserted", task: saved });
        }
        return yield* appendActivity({
          projectId: input.projectId,
          kind: "attempt-recorded",
          actorKind: principal.kind === "user" ? "user" : principal.kind,
          actorThreadId: principal.kind === "user" ? null : principal.threadId,
          goalId: task.goalId,
          taskId: task.id,
          source: null,
          summary: `Worker outcome recorded; task remains under review until accepted. ${input.summary}`,
          createdAt: now,
        });
      }),

    buildContextPacket: (projectId, _threadId) =>
      Effect.gen(function* () {
        const config = yield* requireConfig(projectId);
        const goal = yield* repository
          .getActiveGoal(projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load project goal.")));
        const instructions = yield* repository
          .readDocumentRevision({ projectId, logicalPath: "instructions.md" })
          .pipe(Effect.mapError(toServiceError("Failed to load instructions.")));
        const decisions = yield* repository
          .readDocumentRevision({ projectId, logicalPath: "decisions.md" })
          .pipe(Effect.mapError(toServiceError("Failed to load decisions.")));
        const tasks = yield* repository
          .listTasks({ projectId, includeArchived: false, limit: 40 })
          .pipe(Effect.mapError(toServiceError("Failed to load tasks for context.")));
        const digest = yield* repository
          .getDigest(projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load digest coverage.")));
        const sections = [
          { label: "Goal", text: Option.isSome(goal) ? goal.value.objective : "No active goal." },
          {
            label: "Instructions",
            text: Option.isSome(instructions) ? instructions.value.content : "",
          },
          {
            label: "Decisions",
            text: Option.isSome(decisions) ? decisions.value.content : "",
          },
          {
            label: "Tasks",
            text: tasks.map((task) => `- ${task.status} ${task.title}`).join("\n"),
          },
        ];
        const budget = truncateToContextBudget(sections);
        return {
          projectId,
          goal: Option.getOrNull(goal),
          instructions: Option.isSome(instructions) ? instructions.value.content : "",
          relevantDecisions: Option.isSome(decisions) ? decisions.value.content : "",
          tasks,
          documentReferences: ["instructions.md", "decisions.md", "overview.md"],
          historicalCoverage: Option.isSome(digest) ? digest.value.historicalCoverage : "none",
          characterCount: budget.characterCount,
        };
      }),

    ingestSettledThreadEvent: (input) =>
      Effect.gen(function* () {
        const task = yield* repository
          .findTaskByAssignedThread(input.threadId)
          .pipe(Effect.mapError(toServiceError("Failed to resolve task for event.")));
        const configByCoordinator = yield* repository
          .getConfigByCoordinatorThread(input.threadId)
          .pipe(Effect.mapError(toServiceError("Failed to resolve coordinator for event.")));
        const projectId = Option.isSome(task)
          ? task.value.projectId
          : Option.isSome(configByCoordinator)
            ? configByCoordinator.value.projectId
            : null;
        if (projectId === null) return;
        const config = yield* repository
          .getConfig(projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load coordinator for event.")));
        if (Option.isNone(config) || !config.value.enabled) return;
        if (Option.isSome(configByCoordinator)) {
          yield* appendActivity({
            projectId,
            kind: "wake-skipped",
            actorKind: "system",
            actorThreadId: input.threadId,
            goalId: null,
            taskId: null,
            source: null,
            summary: "Coordinator self-events do not wake coordination.",
            createdAt: input.createdAt,
          });
          return;
        }
        const eligibleWake = Option.isSome(task);
        const inserted = yield* repository
          .insertInboxEvent({
            id: branded.inbox(),
            projectId,
            sourceThreadId: input.threadId,
            sourceEventId: input.sourceEventId,
            eventType: input.eventType,
            taskId: Option.isSome(task) ? task.value.id : null,
            eligibleWake,
            createdAt: input.createdAt,
          })
          .pipe(Effect.mapError(toServiceError("Failed to record project inbox event.")));
        if (!inserted.inserted) return;
        if (eligibleWake) {
          yield* impl.processPendingWakes(projectId);
        } else {
          yield* appendActivity({
            projectId,
            kind: "wake-skipped",
            actorKind: "system",
            actorThreadId: input.threadId,
            goalId: null,
            taskId: null,
            source: null,
            summary: "Unrelated project thread updated activity without granting execution authority.",
            createdAt: input.createdAt,
          });
        }
      }),

    processPendingWakes: (projectId) =>
      Effect.gen(function* () {
        const config = yield* requireConfig(projectId);
        const goal = yield* repository
          .getActiveGoal(projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load goal for wake.")));
        if (Option.isNone(goal) || goal.value.status !== "active") return;
        if (goal.value.continuationCount >= goal.value.limits.maxAutomaticContinuationsPerGoal) {
          yield* repository
            .saveGoal(
              {
                ...goal.value,
                status: "paused",
                revision: goal.value.revision + 1,
                updatedAt: isoNow(),
              },
              goal.value.revision,
            )
            .pipe(Effect.mapError(toServiceError("Failed to pause exhausted goal.")));
          yield* appendActivity({
            projectId,
            kind: "goal-paused",
            actorKind: "system",
            actorThreadId: null,
            goalId: goal.value.id,
            taskId: null,
            source: null,
            summary:
              "Automatic coordinator continuations reached the goal limit. Resume after reviewing outcomes.",
            createdAt: isoNow(),
          });
          return;
        }
        const cursor = yield* repository
          .getCursor(projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load project event cursor.")));
        if (cursor.coordinatorBusy) return;
        const pending = yield* repository
          .listInboxAfter({
            projectId,
            afterId: cursor.processedThroughInboxId,
            limit: 50,
          })
          .pipe(Effect.mapError(toServiceError("Failed to load project inbox.")));
        const eligible = pending.filter((event) => event.eligibleWake);
        if (eligible.length === 0) return;
        const coordinator = yield* snapshotQuery.getThreadShellById(config.coordinatorThreadId).pipe(
          Effect.mapError(toServiceError("Failed to load coordinator thread.")),
        );
        if (Option.isSome(coordinator)) {
          const liveTurn = coordinator.value.latestTurn?.state === "running";
          const busy = liveTurn || coordinator.value.hasPendingApprovals === true;
          if (busy) return;
        }
        if (!config.automationId) return;
        yield* repository
          .saveCursor({
            projectId,
            processedThroughInboxId: cursor.processedThroughInboxId,
            frozenFromInboxId: eligible[0]!.id,
            frozenToInboxId: eligible[eligible.length - 1]!.id,
            coordinatorBusy: true,
            updatedAt: isoNow(),
          })
          .pipe(Effect.mapError(toServiceError("Failed to freeze project event range.")));
        const run = yield* automationService
          .runNow({ automationId: config.automationId })
          .pipe(Effect.mapError(toServiceError("Failed to dispatch coordinator continuation.")));
        yield* repository
          .saveGoal(
            {
              ...goal.value,
              continuationCount: goal.value.continuationCount + 1,
              revision: goal.value.revision + 1,
              updatedAt: isoNow(),
            },
            goal.value.revision,
          )
          .pipe(Effect.mapError(toServiceError("Failed to count coordinator continuation.")));
        yield* repository
          .saveCursor({
            projectId,
            processedThroughInboxId: eligible[eligible.length - 1]!.id,
            frozenFromInboxId: null,
            frozenToInboxId: null,
            coordinatorBusy: false,
            updatedAt: isoNow(),
          })
          .pipe(Effect.mapError(toServiceError("Failed to advance project event cursor.")));
        yield* appendActivity({
          projectId,
          kind: "wake-enqueued",
          actorKind: "system",
          actorThreadId: config.coordinatorThreadId,
          goalId: goal.value.id,
          taskId: eligible[0]?.taskId ?? null,
          source: null,
          summary: `Dispatched coordinator continuation ${run.run.id}. Later events remain queued.`,
          createdAt: isoNow(),
        });
      }),

    resolvePrincipalForThread: (threadId) =>
      Effect.gen(function* () {
        const coordinator = yield* repository
          .getConfigByCoordinatorThread(threadId)
          .pipe(Effect.mapError(toServiceError("Failed to resolve coordinator principal.")));
        if (Option.isSome(coordinator)) {
          return {
            kind: "coordinator" as const,
            threadId,
            projectId: coordinator.value.projectId,
          };
        }
        const task = yield* repository
          .findTaskByAssignedThread(threadId)
          .pipe(Effect.mapError(toServiceError("Failed to resolve worker principal.")));
        if (Option.isSome(task)) {
          return {
            kind: "worker" as const,
            threadId,
            projectId: task.value.projectId,
            taskId: task.value.id,
          };
        }
        return { kind: "user" as const };
      }),

    assertCallerMayDriveManagedThread: (input) =>
      Effect.gen(function* () {
        const caller = yield* impl.resolvePrincipalForThread(input.callerThreadId);
        const target = yield* impl.resolvePrincipalForThread(input.targetThreadId);
        const targetShell = yield* snapshotQuery.getThreadShellById(input.targetThreadId).pipe(
          Effect.mapError(toServiceError("Failed to load target thread.")),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(fail("Target thread was not found.", "not-found")),
              onSome: Effect.succeed,
            }),
          ),
        );
        if (caller.kind === "worker") {
          return yield* Effect.fail(fail("Workers cannot create further workers by default.", "forbidden"));
        }
        if (caller.kind === "coordinator") {
          const goal = yield* repository
            .getActiveGoal(caller.projectId)
            .pipe(Effect.mapError(toServiceError("Failed to load authorized goal.")));
          if (Option.isNone(goal) || goal.value.status !== "active") {
            return yield* Effect.fail(
              fail("The coordinator may drive only threads associated with its active authorized goal.", "forbidden"),
            );
          }
          if (target.kind === "worker" && target.projectId === caller.projectId) return;
          if (targetShell.projectId !== caller.projectId) {
            return yield* Effect.fail(fail("Cross-project control is blocked.", "forbidden"));
          }
          const assigned = yield* repository
            .findTaskByAssignedThread(input.targetThreadId)
            .pipe(Effect.mapError(toServiceError("Failed to load managed worker association.")));
          if (Option.isNone(assigned) || assigned.value.goalId !== goal.value.id) {
            return yield* Effect.fail(
              fail("The coordinator may drive only threads associated with its active authorized goal.", "forbidden"),
            );
          }
        }
      }),

    onProjectDeleted: (projectId) =>
      Effect.gen(function* () {
        const config = yield* repository
          .getConfig(projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load coordinator for deletion.")));
        if (Option.isNone(config)) return;
        const disabled: ProjectAgentConfig = {
          ...config.value,
          enabled: false,
          revision: config.value.revision + 1,
          updatedAt: isoNow(),
          disabledAt: isoNow(),
        };
        yield* repository
          .saveConfig(disabled, config.value.revision)
          .pipe(Effect.mapError(toServiceError("Failed to disable coordinator after project deletion.")));
        const goal = yield* repository
          .getActiveGoal(projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load goal for deletion.")));
        if (Option.isSome(goal)) {
          yield* repository
            .saveGoal(
              {
                ...goal.value,
                status: "stopped",
                revision: goal.value.revision + 1,
                updatedAt: isoNow(),
              },
              goal.value.revision,
            )
            .pipe(Effect.mapError(toServiceError("Failed to stop goal after project deletion.")));
        }
      }),

    streamEvents: (input) =>
      Stream.concat(
        Stream.fromEffect(buildOverview(input.projectId).pipe(Effect.map((overview) => ({ type: "snapshot" as const, overview })))),
        Stream.fromPubSub(events).pipe(
          Stream.filter((event) => {
            if (event.type === "snapshot") return event.overview.projectId === input.projectId;
            if (event.type === "config-upserted") return event.config.projectId === input.projectId;
            if (event.type === "goal-upserted") return event.goal.projectId === input.projectId;
            if (event.type === "task-upserted") return event.task.projectId === input.projectId;
            if (event.type === "activity-appended") return event.activity.projectId === input.projectId;
            if (event.type === "digest-upserted") return event.digest.projectId === input.projectId;
            return event.head.projectId === input.projectId;
          }),
        ),
      ),
  };

  const unblockDependents = (accepted: ProjectTask) =>
    Effect.gen(function* () {
      const tasks = yield* repository
        .listTasks({ projectId: accepted.projectId, includeArchived: false, limit: 100 })
        .pipe(Effect.mapError(toServiceError("Failed to load dependent tasks.")));
      for (const task of tasks) {
        if (task.status !== "planned" && task.status !== "blocked") continue;
        if (!task.dependsOnTaskIds.includes(accepted.id)) continue;
        const prerequisites = yield* Effect.forEach(task.dependsOnTaskIds, (id) => repository.getTask(id));
        const ready = prerequisites.every((option) => Option.isSome(option) && option.value.status === "done");
        if (!ready) continue;
        const updated: ProjectTask = {
          ...task,
          status: "ready",
          revision: task.revision + 1,
          updatedAt: isoNow(),
        };
        const saved = yield* repository
          .saveTask(updated, task.revision)
          .pipe(Effect.mapError(toServiceError("Failed to unblock dependent task.")));
        yield* publish({ type: "task-upserted", task: saved });
      }
    });

  const updateGoalStatus = (
    input: Parameters<ProjectAgentServiceShape["pauseGoal"]>[0],
    principal: ProjectAgentPrincipal,
    status: ProjectGoal["status"],
    kind: ProjectActivity["kind"],
    summary: string,
  ) =>
    Effect.gen(function* () {
      if (!isUserPrincipal(principal) && !isCoordinatorPrincipal(principal, input.projectId)) {
        return yield* Effect.fail(fail("Goal controls require the user or coordinator.", "forbidden"));
      }
      if (status === "stopped" && !isUserPrincipal(principal)) {
        return yield* Effect.fail(fail("Stopping a goal is a user action.", "forbidden"));
      }
      const current = yield* repository.getGoal(input.goalId).pipe(
        Effect.mapError(toServiceError("Failed to load project goal.")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(fail("Goal was not found.", "not-found")),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (current.projectId !== input.projectId) {
        return yield* Effect.fail(fail("Goal does not belong to this project.", "forbidden"));
      }
      const updated: ProjectGoal = {
        ...current,
        status,
        revision: current.revision + 1,
        updatedAt: isoNow(),
      };
      const saved = yield* repository
        .saveGoal(updated, input.expectedRevision)
        .pipe(Effect.mapError(toServiceError("Failed to update project goal.")));
      if (status === "stopped" && current.status !== "stopped") {
        const config = yield* requireConfig(input.projectId);
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: branded.command(),
            threadId: config.coordinatorThreadId,
            createdAt: isoNow(),
          } as OrchestrationCommand)
          .pipe(Effect.catch(() => Effect.void));
        const tasks = yield* repository
          .listTasks({ projectId: input.projectId, goalId: saved.id, includeArchived: false, limit: 100 })
          .pipe(Effect.mapError(toServiceError("Failed to list managed workers.")));
        for (const task of tasks) {
          if (!task.assignedThreadId || task.status === "done" || task.status === "cancelled") continue;
          yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: branded.command(),
              threadId: task.assignedThreadId,
              createdAt: isoNow(),
            } as OrchestrationCommand)
            .pipe(Effect.catch(() => Effect.void));
        }
      }
      yield* publish({ type: "goal-upserted", goal: saved });
      yield* appendActivity({
        projectId: input.projectId,
        kind,
        actorKind: principal.kind === "user" ? "user" : "coordinator",
        actorThreadId: principal.kind === "user" ? null : principal.threadId,
        goalId: saved.id,
        taskId: null,
        source: null,
        summary,
        createdAt: saved.updatedAt,
      });
      return saved;
    });

  return {
    ...impl,
    pauseGoal: (input, principal) => updateGoalStatus(input, principal, "paused", "goal-paused", "Paused the project goal. Current tasks may settle."),
    resumeGoal: (input, principal) => updateGoalStatus(input, principal, "active", "goal-resumed", "Resumed the project goal."),
    stopGoal: (input, principal) =>
      updateGoalStatus(
        input,
        principal,
        "stopped",
        "goal-stopped",
        "Stopped the project goal. Pending continuations were cancelled.",
      ),
  } satisfies ProjectAgentServiceShape;
});

export const ProjectAgentServiceLive = Layer.effect(ProjectAgentService, makeProjectAgentService);
