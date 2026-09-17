import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  AutomationId,
  CommandId,
  DEFAULT_PROJECT_AGENT_LIMITS,
  PROJECT_AGENT_DIGEST_DEBOUNCE_MS,
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
  type ProjectAgentSummary,
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
import { Cause, Duration, Effect, Layer, Option, PubSub, Queue, Ref, Stream } from "effect";

import { AutomationService } from "../../automation/Services/AutomationService.ts";
import { ServerConfig } from "../../config.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
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
  mergePinnedFocusItems,
  validateDigestFocusItems,
  wakeReceiptRequestId,
} from "../digest.ts";
import {
  canAcceptTask,
  canConfigureProject,
  canStartGoal,
  canWriteUserOwnedDocuments,
  coordinatorStatusFromGoal,
  isCoordinatorPrincipal,
  isUserPrincipal,
  projectAgentSummariesForPrincipal,
  type ProjectAgentPrincipal,
} from "../principal.ts";
import { PROJECT_BOT_PLAYBOOK, PROJECT_BOT_PLAYBOOK_PATH } from "../projectBotPlaybook.ts";
import {
  ProjectAgentService,
  type ProjectAgentServiceShape,
} from "../Services/ProjectAgentService.ts";

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
  { path: PROJECT_BOT_PLAYBOOK_PATH, content: PROJECT_BOT_PLAYBOOK },
  { path: "internal/manifest.json", content: "{}\n" },
];

export const makeProjectAgentService = Effect.gen(function* () {
  const repository = yield* ProjectAgentRepository;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionThreads = yield* ProjectionThreadRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const automationService = yield* AutomationService;
  const serverConfig = yield* ServerConfig;
  const textGeneration = yield* TextGeneration;
  const events = yield* PubSub.unbounded<ProjectAgentStreamEvent>();
  const digestInflight = yield* Ref.make(new Set<string>());
  const digestPending = yield* Ref.make(new Set<string>());
  const digestTimer = yield* Ref.make(new Set<string>());

  const publish = (event: ProjectAgentStreamEvent) =>
    PubSub.publish(events, event).pipe(Effect.asVoid);
  const toServiceError = (message: string) => (cause: unknown) =>
    new ProjectAgentServiceError({
      message:
        cause instanceof Error && cause.message.includes("revision mismatch")
          ? "This project record changed. Reload and retry with the latest revision."
          : message,
      code:
        cause instanceof Error && cause.message.includes("revision mismatch")
          ? "conflict"
          : "invalid",
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
              : Effect.fail(
                  fail("Project Coordinator is only available on ordinary projects.", "forbidden"),
                );
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

  const ensureProjectBotPlaybook = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const existingPlaybook = yield* repository
        .readDocumentRevision({ projectId, logicalPath: PROJECT_BOT_PLAYBOOK_PATH })
        .pipe(Effect.mapError(toServiceError("Failed to load project bot playbook.")));
      if (Option.isSome(existingPlaybook)) return;
      yield* writeSeedDocument(
        projectId,
        PROJECT_BOT_PLAYBOOK_PATH,
        PROJECT_BOT_PLAYBOOK,
        "system",
      );
    });

  const indexProjectThreads = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const threads = yield* projectionThreads
        .listByProjectId({ projectId })
        .pipe(Effect.mapError(toServiceError("Failed to index project threads.")));
      const existing = yield* repository
        .listThreadIndex(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load thread coverage.")));
      const excludedIds = new Set(
        existing.filter((entry) => entry.excluded).map((entry) => entry.threadId),
      );
      const coveredIds = new Set(
        existing
          .filter((entry) => entry.summaryStatus === "covered" && !entry.excluded)
          .map((entry) => entry.threadId),
      );
      const persistent = threads.filter((thread) => thread.deletedAt === null);
      const sorted = [...persistent].toSorted((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
      let assignedCoverage = coveredIds.size;
      for (const thread of sorted) {
        const excluded = excludedIds.has(thread.threadId);
        const alreadyCovered = coveredIds.has(thread.threadId);
        const covered =
          alreadyCovered ||
          (!excluded && assignedCoverage < PROJECT_AGENT_INITIAL_SUMMARY_THREAD_COUNT);
        if (covered && !alreadyCovered && !excluded) assignedCoverage += 1;
        yield* repository
          .upsertThreadIndex({
            projectId,
            threadId: thread.threadId,
            excluded,
            archived: thread.archivedAt !== null,
            summaryStatus: excluded ? "skipped" : covered ? "covered" : "pending",
            lastUpdatedAt: thread.updatedAt,
            lastSummarizedAt: covered && !excluded ? isoNow() : null,
          })
          .pipe(Effect.mapError(toServiceError("Failed to store thread index.")));
      }
      const index = yield* repository
        .listThreadIndex(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load thread coverage.")));
      const summarizedThreadCount = index.filter(
        (entry) => entry.summaryStatus === "covered",
      ).length;
      const pendingThreadCount = index.filter(
        (entry) => !entry.excluded && entry.summaryStatus === "pending",
      ).length;
      return { summarizedThreadCount, pendingThreadCount };
    });

  const buildOverview = (
    projectId: ProjectId,
  ): Effect.Effect<ProjectAgentOverview, ProjectAgentServiceError> =>
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
      return {
        projectId,
        configured: true,
        config: config.value,
        goal: goalValue,
        digest: Option.getOrNull(digest),
        blockers,
        recentOutcomes: activity,
        coordinatorStatus: coordinatorStatusFromGoal(true, goalValue?.status ?? null),
      };
    });

  const replayReceipt = <A>(requestId: string, decode: (json: string) => A) =>
    repository.getReceipt(requestId).pipe(
      Effect.mapError(toServiceError("Failed to load request receipt.")),
      Effect.map((option) => (Option.isSome(option) ? decode(option.value.resultJson) : null)),
    );

  const storeReceipt = (
    requestId: string,
    projectId: ProjectId,
    operation: string,
    result: unknown,
  ) =>
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
      return Effect.fail(
        fail("This thread cannot access another project's coordinator.", "forbidden"),
      );
    }
    return Effect.void;
  };

  const generateDigestNow = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const inflight = yield* Ref.get(digestInflight);
      if (inflight.has(projectId)) {
        yield* Ref.update(digestPending, (pending) => new Set(pending).add(projectId));
        return;
      }
      yield* Ref.update(digestInflight, (current) => new Set(current).add(projectId));
      yield* Ref.update(digestPending, (pending) => {
        const next = new Set(pending);
        next.delete(projectId);
        return next;
      });
      const previous = yield* repository
        .getDigest(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load digest.")));
      const lastGood = Option.isSome(previous) ? previous.value : null;
      const coverage = yield* indexProjectThreads(projectId);
      const activity = yield* repository
        .listActivity({ projectId, limit: 40 })
        .pipe(Effect.mapError(toServiceError("Failed to load digest activity.")));
      const tasks = yield* repository
        .listTasks({ projectId, includeArchived: false, limit: 100 })
        .pipe(Effect.mapError(toServiceError("Failed to load digest tasks.")));
      const documents = yield* repository
        .listDocumentHeads(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load digest documents.")));
      const threads = yield* repository
        .listThreadIndex(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load digest threads.")));
      const running = {
        projectId,
        summary: lastGood?.summary ?? "Generating project summary…",
        focusItems: lastGood?.focusItems ?? [],
        coverageFromSequence: lastGood?.coverageFromSequence ?? 0,
        coverageToSequence: activity[0]?.sequence ?? lastGood?.coverageToSequence ?? 0,
        historicalCoverage:
          coverage.pendingThreadCount > 0 ? ("partial" as const) : ("complete" as const),
        summarizedThreadCount: coverage.summarizedThreadCount,
        pendingThreadCount: coverage.pendingThreadCount,
        generationState: "running" as const,
        generatedAt: lastGood?.generatedAt ?? null,
        lastGoodAt: lastGood?.lastGoodAt ?? null,
        lastError: null,
      };
      yield* repository
        .saveDigest(running)
        .pipe(Effect.mapError(toServiceError("Failed to mark digest running.")));
      const project = yield* snapshotQuery
        .getProjectShellById(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load project for digest.")));
      const cwd = Option.isSome(project) ? project.value.workspaceRoot : serverConfig.cwd;
      const allowed = new Set([
        ...activity.map((entry) => entry.id),
        ...tasks.map((task) => task.id),
        ...threads.map((thread) => thread.threadId),
        ...documents.map((doc) => doc.logicalPath),
      ]);
      const generated = yield* textGeneration
        .generateProjectDigest({
          cwd,
          previousSummary: lastGood?.summary,
          activity: activity.map((entry) => `${entry.id}: ${entry.summary}`).join("\n"),
          coverage: `summarized=${coverage.summarizedThreadCount} pending=${coverage.pendingThreadCount}`,
          pinnedFocus: (lastGood?.focusItems ?? [])
            .filter((item) => item.pinned)
            .map((item) => item.title)
            .join("\n"),
        })
        .pipe(
          Effect.map((result) => ({
            summary: result.summary,
            focusItems: mergePinnedFocusItems(
              validateDigestFocusItems(result.focusItems, allowed),
              (lastGood?.focusItems ?? []).filter((item) => item.pinned),
            ),
            error: null as string | null,
          })),
          Effect.catch((error) =>
            Effect.succeed({
              summary:
                lastGood?.summary ??
                "Project summary is unavailable until the next successful refresh.",
              focusItems: lastGood?.focusItems ?? [],
              error: error instanceof Error ? error.message : "Project digest generation failed.",
            }),
          ),
        );
      const digest = {
        projectId,
        summary: generated.summary,
        focusItems: generated.focusItems,
        coverageFromSequence: lastGood?.coverageFromSequence ?? 0,
        coverageToSequence: activity[0]?.sequence ?? 0,
        historicalCoverage:
          coverage.pendingThreadCount > 0 ? ("partial" as const) : ("complete" as const),
        summarizedThreadCount: coverage.summarizedThreadCount,
        pendingThreadCount: coverage.pendingThreadCount,
        generationState: generated.error ? ("failed" as const) : ("idle" as const),
        generatedAt: generated.error ? (lastGood?.generatedAt ?? null) : isoNow(),
        lastGoodAt: generated.error ? (lastGood?.lastGoodAt ?? null) : isoNow(),
        lastError: generated.error,
      };
      yield* repository
        .saveDigest(digest)
        .pipe(Effect.mapError(toServiceError("Failed to save digest.")));
      yield* publish({ type: "digest-upserted", digest });
      yield* Ref.update(digestInflight, (current) => {
        const next = new Set(current);
        next.delete(projectId);
        return next;
      });
      const stillPending = yield* Ref.get(digestPending);
      if (stillPending.has(projectId)) {
        yield* impl.scheduleDigest(projectId);
      }
    }).pipe(
      Effect.ensuring(
        Ref.update(digestInflight, (current) => {
          const next = new Set(current);
          next.delete(projectId);
          return next;
        }),
      ),
    );

  const impl: ProjectAgentServiceShape = {
    getOverview: (input, principal) =>
      assertSameProject(principal, input.projectId).pipe(
        Effect.andThen(requireOrdinaryProject(input.projectId)),
        Effect.andThen(buildOverview(input.projectId)),
      ),

    listSummaries: (_input, principal) =>
      repository.listSummaries().pipe(
        Effect.mapError(toServiceError("Failed to list project agents.")),
        Effect.map((rows) => {
          const summaries: ReadonlyArray<ProjectAgentSummary> = rows.map((row) => ({
            projectId: row.projectId,
            configured: true,
            coordinatorName: row.coordinatorName,
            coordinatorThreadId: row.coordinatorThreadId,
            coordinatorStatus: coordinatorStatusFromGoal(true, row.goalStatus),
            revision: row.revision,
          }));
          return { summaries: [...projectAgentSummariesForPrincipal(summaries, principal)] };
        }),
      ),

    configure: (input, principal) =>
      Effect.gen(function* () {
        if (!canConfigureProject(principal)) {
          return yield* Effect.fail(
            fail("Only the user can configure Project Coordinator.", "forbidden"),
          );
        }
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          (json) => JSON.parse(json) as ProjectAgentOverview,
        );
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
          if (
            input.expectedRevision !== undefined &&
            input.expectedRevision !== existing.value.revision
          ) {
            return yield* Effect.fail(
              fail("Coordinator settings changed. Reload and retry.", "conflict"),
            );
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
          limits: input.limits ?? { ...DEFAULT_PROJECT_AGENT_LIMITS },
          captureEnabled: input.captureEnabled ?? true,
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
              summary:
                "Imported existing project instructions without overwriting newer server content.",
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
        yield* ensureProjectBotPlaybook(input.projectId);
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
          return yield* Effect.fail(
            fail("Goal authorization can originate only from a user action.", "forbidden"),
          );
        }
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          (json) => JSON.parse(json) as ProjectGoal,
        );
        if (existingReceipt) return existingReceipt;
        yield* requireOrdinaryProject(input.projectId);
        const config = yield* requireConfig(input.projectId);
        const open = yield* repository
          .getActiveGoal(input.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load project goal.")));
        if (Option.isSome(open)) {
          return yield* Effect.fail(
            fail("This project already has an active or paused goal.", "conflict"),
          );
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
          return yield* Effect.fail(
            fail("Changing authorized goal scope is a user action.", "forbidden"),
          );
        }
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          (json) => JSON.parse(json) as ProjectGoal,
        );
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
            input.acceptanceCriteria === undefined
              ? current.acceptanceCriteria
              : input.acceptanceCriteria,
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
      updateGoalStatus(
        input,
        principal,
        "paused",
        "goal-paused",
        "Paused the project goal. Current tasks may settle.",
      ),
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
              includeArchived: input.includeArchived ?? false,
              limit: input.limit ?? 50,
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
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          (json) => JSON.parse(json) as ProjectTask,
        );
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
          return yield* Effect.fail(
            fail("Tasks can only be created for an active goal.", "invalid"),
          );
        }
        const edges = yield* repository
          .listTaskEdges(input.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load task dependencies.")));
        const taskId = branded.task();
        const dependsOnTaskIds = input.dependsOnTaskIds ?? [];
        if (
          detectProjectTaskDependencyCycle({
            taskId,
            dependsOnTaskIds,
            edges,
          })
        ) {
          return yield* Effect.fail(fail("Task dependencies cannot form a cycle.", "cycle"));
        }
        for (const dependencyId of dependsOnTaskIds) {
          const dependency = yield* repository
            .getTask(dependencyId)
            .pipe(Effect.mapError(toServiceError("Failed to load task dependency.")));
          if (Option.isNone(dependency) || dependency.value.projectId !== input.projectId) {
            return yield* Effect.fail(
              fail("Task dependencies must belong to the same project.", "invalid"),
            );
          }
        }
        const ready =
          dependsOnTaskIds.length === 0 ||
          (yield* Effect.forEach(dependsOnTaskIds, (id) =>
            repository
              .getTask(id)
              .pipe(Effect.mapError(toServiceError("Failed to load task dependency."))),
          )).every((option) => Option.isSome(option) && option.value.status === "done");
        const now = isoNow();
        const task: ProjectTask = {
          id: taskId,
          projectId: input.projectId,
          goalId: input.goalId,
          title: input.title,
          description: input.description ?? null,
          acceptanceCriteria: input.acceptanceCriteria ?? null,
          status: ready ? "ready" : "planned",
          dependsOnTaskIds,
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
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          (json) => JSON.parse(json) as ProjectTask,
        );
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
              fail(
                "A worker cannot mark a task accepted. Acceptance requires the coordinator or user.",
                "forbidden",
              ),
            );
          }
          if (
            current.status !== "review" &&
            current.status !== "ready" &&
            current.status !== "running"
          ) {
            return yield* Effect.fail(
              fail("Only reviewed work can be accepted against recorded evidence.", "invalid"),
            );
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
            fail(
              "A finished provider turn updates an attempt. It cannot mark a task done.",
              "forbidden",
            ),
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
          : (input.status ?? current.status);
        const updated: ProjectTask = {
          ...current,
          title: input.title ?? current.title,
          description: input.description === undefined ? current.description : input.description,
          acceptanceCriteria:
            input.acceptanceCriteria === undefined
              ? current.acceptanceCriteria
              : input.acceptanceCriteria,
          status: nextStatus,
          dependsOnTaskIds,
          archivedAt:
            input.archived === undefined
              ? current.archivedAt
              : input.archived
                ? (current.archivedAt ?? isoNow())
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
          actorKind:
            principal.kind === "worker"
              ? "worker"
              : principal.kind === "coordinator"
                ? "coordinator"
                : "user",
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
              limit: input.limit ?? 50,
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
          return yield* Effect.fail(
            fail("Generated views cannot be overwritten directly.", "forbidden"),
          );
        }
        if (isUserOwnedDocumentPath(logicalPath) && !canWriteUserOwnedDocuments(principal)) {
          return yield* Effect.fail(
            fail("Only the user can edit project instructions and notes.", "forbidden"),
          );
        }
        if (isInboxDocumentPath(logicalPath) && principal.kind === "worker") {
          const expectedPrefix = `inbox/${principal.threadId}/`;
          if (!logicalPath.startsWith(expectedPrefix)) {
            return yield* Effect.fail(
              fail("Workers can only write their own inbox entries.", "forbidden"),
            );
          }
        }
        if (isCoordinatorCuratedDocumentPath(logicalPath) && principal.kind === "worker") {
          return yield* Effect.fail(
            fail("Workers cannot rewrite curated project knowledge.", "forbidden"),
          );
        }
        const head = yield* repository
          .getDocumentHead(input.projectId, logicalPath)
          .pipe(Effect.mapError(toServiceError("Failed to load document head.")));
        const currentRevision = Option.isSome(head) ? head.value.revision : 0;
        if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
          return yield* Effect.fail(
            fail("Document changed. Reload and retry with the latest revision.", "conflict"),
          );
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
          authorKind:
            principal.kind === "user"
              ? "user"
              : principal.kind === "coordinator"
                ? "coordinator"
                : "worker",
          authorThreadId: principal.kind === "user" ? null : principal.threadId,
          sources: input.sources ?? [],
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
          return yield* Effect.fail(
            fail("Exporting project documents is a user action.", "forbidden"),
          );
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
            return yield* Effect.fail(
              fail("Export destination escaped the chosen directory.", "invalid"),
            );
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
        yield* generateDigestNow(input.projectId);
        return yield* buildOverview(input.projectId);
      }),

    scheduleDigest: (projectId) =>
      Effect.gen(function* () {
        yield* Ref.update(digestPending, (pending) => new Set(pending).add(projectId));
        const timers = yield* Ref.get(digestTimer);
        if (timers.has(projectId)) return;
        yield* Ref.update(digestTimer, (current) => new Set(current).add(projectId));
        yield* Effect.sleep(Duration.millis(PROJECT_AGENT_DIGEST_DEBOUNCE_MS)).pipe(
          Effect.andThen(generateDigestNow(projectId)),
          Effect.catch(() => Effect.void),
          Effect.ensuring(
            Ref.update(digestTimer, (current) => {
              const next = new Set(current);
              next.delete(projectId);
              return next;
            }),
          ),
          Effect.forkChild,
        );
      }).pipe(Effect.asVoid),

    listEvidence: (input, principal) =>
      assertSameProject(principal, input.projectId).pipe(
        Effect.andThen(
          repository
            .listEvidenceForTask(input.taskId)
            .pipe(Effect.mapError(toServiceError("Failed to list task evidence."))),
        ),
        Effect.map((evidence) => ({ evidence })),
      ),

    listThreadIndex: (input, principal) =>
      assertSameProject(principal, input.projectId).pipe(
        Effect.andThen(
          repository
            .listThreadIndex(input.projectId)
            .pipe(Effect.mapError(toServiceError("Failed to list project threads."))),
        ),
        Effect.map((threads) => ({ threads })),
      ),

    excludeThread: (input, principal) =>
      Effect.gen(function* () {
        if (!isUserPrincipal(principal)) {
          return yield* Effect.fail(fail("Thread coverage is a user action.", "forbidden"));
        }
        yield* requireConfig(input.projectId);
        const existing = yield* repository
          .listThreadIndex(input.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load thread coverage.")));
        const current = existing.find((entry) => entry.threadId === input.threadId);
        const entry = {
          projectId: input.projectId,
          threadId: input.threadId,
          excluded: input.excluded,
          archived: current?.archived ?? false,
          summaryStatus: input.excluded
            ? ("skipped" as const)
            : (current?.summaryStatus ?? "pending"),
          lastUpdatedAt: isoNow(),
          lastSummarizedAt: current?.lastSummarizedAt ?? null,
        };
        yield* repository
          .upsertThreadIndex(entry)
          .pipe(Effect.mapError(toServiceError("Failed to update thread coverage.")));
        yield* impl.scheduleDigest(input.projectId);
        return entry;
      }),

    backfillSummaries: (input, principal) =>
      Effect.gen(function* () {
        if (!isUserPrincipal(principal)) {
          return yield* Effect.fail(fail("Historical backfill is a user action.", "forbidden"));
        }
        const index = yield* repository
          .listThreadIndex(input.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load pending threads.")));
        const pending = index.filter(
          (entry) => !entry.excluded && entry.summaryStatus === "pending",
        );
        for (const entry of pending.slice(0, PROJECT_AGENT_INITIAL_SUMMARY_THREAD_COUNT)) {
          yield* repository
            .upsertThreadIndex({
              ...entry,
              summaryStatus: "covered",
              lastSummarizedAt: isoNow(),
            })
            .pipe(Effect.mapError(toServiceError("Failed to backfill thread summary.")));
        }
        yield* generateDigestNow(input.projectId);
        return yield* buildOverview(input.projectId);
      }),

    formatContextPacketForTurn: (threadId) =>
      Effect.gen(function* () {
        const principal = yield* impl.resolvePrincipalForThread(threadId);
        if (principal.kind !== "coordinator" && principal.kind !== "worker") {
          return "";
        }
        if (principal.kind === "coordinator") {
          yield* ensureProjectBotPlaybook(principal.projectId);
        }
        const packet = yield* impl.buildContextPacket(principal.projectId, threadId);
        const playbook = yield* repository
          .readDocumentRevision({
            projectId: principal.projectId,
            logicalPath: PROJECT_BOT_PLAYBOOK_PATH,
          })
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        const budget = truncateToContextBudget([
          {
            label: "Playbook",
            text: Option.isSome(playbook) ? playbook.value.content : PROJECT_BOT_PLAYBOOK,
          },
          { label: "Goal", text: packet.goal?.objective ?? "No active goal." },
          { label: "Instructions", text: packet.instructions },
          { label: "Decisions", text: packet.relevantDecisions },
          {
            label: "Tasks",
            text: packet.tasks.map((task) => `- ${task.status} ${task.title}`).join("\n"),
          },
        ]);
        return [
          "Project context packet (authoritative durable state; additional documents via synara_project_read_document):",
          budget.packet,
          packet.historicalCoverage === "partial"
            ? "Historical coverage is partial; remaining threads are not yet summarized."
            : "",
        ]
          .filter((section) => section.length > 0)
          .join("\n\n");
      }),

    authorizeManagedGoalCreation: (input) =>
      Effect.gen(function* () {
        const principal = yield* impl.resolvePrincipalForThread(input.callerThreadId);
        if (principal.kind !== "coordinator") return;
        const goal = yield* repository
          .getActiveGoal(principal.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load authorized goal.")));
        if (Option.isNone(goal) || goal.value.status !== "active") {
          return yield* Effect.fail(
            fail(
              "The coordinator can create workers only while a user-authorized goal is active.",
              "forbidden",
            ),
          );
        }
        const running = yield* repository
          .countRunningWorkers(principal.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to count running workers.")));
        if (input.requestedCount > goal.value.limits.maxNewWorkersPerTurn) {
          return yield* Effect.fail(
            fail(
              `This goal allows at most ${goal.value.limits.maxNewWorkersPerTurn} new workers per turn.`,
              "limit",
            ),
          );
        }
        if (running + input.requestedCount > goal.value.limits.maxConcurrentWorkers) {
          return yield* Effect.fail(
            fail(
              `This goal allows at most ${goal.value.limits.maxConcurrentWorkers} concurrent workers.`,
              "limit",
            ),
          );
        }
        if (
          goal.value.workerCreationCount + input.requestedCount >
          goal.value.limits.maxWorkerCreationsPerGoal
        ) {
          return yield* Effect.fail(
            fail(
              `This goal allows at most ${goal.value.limits.maxWorkerCreationsPerGoal} worker creations.`,
              "limit",
            ),
          );
        }
      }),

    recordManagedWorkerThreads: (input) =>
      Effect.gen(function* () {
        const principal = yield* impl.resolvePrincipalForThread(input.callerThreadId);
        if (principal.kind !== "coordinator") return;
        const goal = yield* repository
          .getActiveGoal(principal.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load authorized goal.")));
        if (Option.isNone(goal) || goal.value.status !== "active") return;
        for (const [index, threadId] of input.threadIds.entries()) {
          const task = yield* impl.createTask(
            {
              requestId: `${input.requestId}:task:${threadId}`,
              projectId: principal.projectId,
              goalId: goal.value.id,
              title: input.titles[index] ?? `Worker ${index + 1}`,
              dependsOnTaskIds: [],
            },
            principal,
          );
          const assigned = {
            ...task,
            status: "running" as const,
            assignedThreadId: threadId,
            revision: task.revision + 1,
            updatedAt: isoNow(),
          };
          yield* repository
            .saveTask(assigned, task.revision)
            .pipe(Effect.mapError(toServiceError("Failed to assign worker thread.")));
          yield* repository
            .saveAttempt({
              id: branded.attempt(),
              projectId: principal.projectId,
              taskId: task.id,
              workerThreadId: threadId,
              gatewayOperationId: input.requestId,
              requestId: `${input.requestId}:attempt:${threadId}`,
              attemptNumber: 1,
              outcome: "running",
              error: null,
              createdAt: isoNow(),
              finishedAt: null,
            })
            .pipe(Effect.mapError(toServiceError("Failed to record worker attempt.")));
        }
        yield* repository
          .saveGoal(
            {
              ...goal.value,
              workerCreationCount: goal.value.workerCreationCount + input.threadIds.length,
              revision: goal.value.revision + 1,
              updatedAt: isoNow(),
            },
            goal.value.revision,
          )
          .pipe(Effect.mapError(toServiceError("Failed to count worker creations.")));
      }),

    reconcilePendingWakes: () =>
      Effect.gen(function* () {
        const configs = yield* repository
          .listConfigs()
          .pipe(Effect.mapError(toServiceError("Failed to list project coordinators.")));
        for (const config of configs) {
          if (!config.enabled) continue;
          const cursor = yield* repository
            .getCursor(config.projectId)
            .pipe(Effect.mapError(toServiceError("Failed to load wake cursor.")));
          if (cursor.coordinatorBusy || cursor.frozenFromInboxId) {
            yield* impl.processPendingWakes(config.projectId);
          }
        }
      }),

    reportResult: (input, principal) =>
      Effect.gen(function* () {
        if (
          principal.kind !== "worker" &&
          principal.kind !== "coordinator" &&
          principal.kind !== "user"
        ) {
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
            kind: input.evidenceKind ?? "message",
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
        const playbook = yield* repository
          .readDocumentRevision({ projectId, logicalPath: PROJECT_BOT_PLAYBOOK_PATH })
          .pipe(Effect.mapError(toServiceError("Failed to load project bot playbook.")));
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
            label: "Playbook",
            text: Option.isSome(playbook) ? playbook.value.content : PROJECT_BOT_PLAYBOOK,
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
          documentReferences: [
            "instructions.md",
            "decisions.md",
            "overview.md",
            PROJECT_BOT_PLAYBOOK_PATH,
          ],
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
        yield* impl.scheduleDigest(projectId);
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
            summary:
              "Unrelated project thread updated activity without granting execution authority.",
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
        const coordinator = yield* snapshotQuery
          .getThreadShellById(config.coordinatorThreadId)
          .pipe(Effect.mapError(toServiceError("Failed to load coordinator thread.")));
        if (Option.isSome(coordinator)) {
          const liveTurn = coordinator.value.latestTurn?.state === "running";
          const busy = liveTurn || coordinator.value.hasPendingApprovals === true;
          if (busy) return;
        }
        if (!config.automationId) return;
        const fromInboxId = eligible[0]!.id;
        const toInboxId = eligible[eligible.length - 1]!.id;
        const receiptId = wakeReceiptRequestId({
          projectId,
          fromInboxId,
          toInboxId,
        });
        const existingWake = yield* repository
          .getReceipt(receiptId)
          .pipe(Effect.mapError(toServiceError("Failed to load wake receipt.")));
        yield* repository
          .saveCursor({
            projectId,
            processedThroughInboxId: cursor.processedThroughInboxId,
            frozenFromInboxId: fromInboxId,
            frozenToInboxId: toInboxId,
            coordinatorBusy: true,
            updatedAt: isoNow(),
          })
          .pipe(Effect.mapError(toServiceError("Failed to freeze project event range.")));
        const latestGoal = yield* repository
          .getActiveGoal(projectId)
          .pipe(Effect.mapError(toServiceError("Failed to re-check goal before wake.")));
        if (Option.isNone(latestGoal) || latestGoal.value.status !== "active") {
          yield* repository
            .saveCursor({
              projectId,
              processedThroughInboxId: cursor.processedThroughInboxId,
              frozenFromInboxId: null,
              frozenToInboxId: null,
              coordinatorBusy: false,
              updatedAt: isoNow(),
            })
            .pipe(Effect.mapError(toServiceError("Failed to unfreeze stale wake.")));
          return;
        }
        let runId = Option.isSome(existingWake)
          ? (JSON.parse(existingWake.value.resultJson) as { runId?: string }).runId
          : undefined;
        if (!runId) {
          const run = yield* automationService
            .runNow({ automationId: config.automationId })
            .pipe(Effect.mapError(toServiceError("Failed to dispatch coordinator continuation.")));
          runId = run.run.id;
          yield* storeReceipt(receiptId, projectId, "wake", { runId });
          yield* repository
            .saveGoal(
              {
                ...latestGoal.value,
                continuationCount: latestGoal.value.continuationCount + 1,
                revision: latestGoal.value.revision + 1,
                updatedAt: isoNow(),
              },
              latestGoal.value.revision,
            )
            .pipe(Effect.mapError(toServiceError("Failed to count coordinator continuation.")));
        }
        yield* repository
          .saveCursor({
            projectId,
            processedThroughInboxId: toInboxId,
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
          goalId: latestGoal.value.id,
          taskId: eligible[0]?.taskId ?? null,
          source: null,
          summary: `Dispatched coordinator continuation ${runId}. Later events remain queued.`,
          createdAt: isoNow(),
        });
        yield* impl.scheduleDigest(projectId);
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
        const shell = yield* snapshotQuery
          .getThreadShellById(threadId)
          .pipe(Effect.mapError(toServiceError("Failed to resolve thread project.")));
        if (Option.isNone(shell)) {
          return yield* Effect.fail(fail("Thread was not found.", "not-found"));
        }
        return {
          kind: "unmanaged" as const,
          threadId,
          projectId: shell.value.projectId,
        };
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
          return yield* Effect.fail(
            fail("Workers cannot create further workers by default.", "forbidden"),
          );
        }
        if (caller.kind === "coordinator") {
          const goal = yield* repository
            .getActiveGoal(caller.projectId)
            .pipe(Effect.mapError(toServiceError("Failed to load authorized goal.")));
          if (Option.isNone(goal) || goal.value.status !== "active") {
            return yield* Effect.fail(
              fail(
                "The coordinator may drive only threads associated with its active authorized goal.",
                "forbidden",
              ),
            );
          }
          if (targetShell.projectId !== caller.projectId) {
            return yield* Effect.fail(fail("Cross-project control is blocked.", "forbidden"));
          }
          const assigned = yield* repository
            .findTaskByAssignedThread(input.targetThreadId)
            .pipe(Effect.mapError(toServiceError("Failed to load managed worker association.")));
          if (Option.isNone(assigned) || assigned.value.goalId !== goal.value.id) {
            return yield* Effect.fail(
              fail(
                "The coordinator may drive only threads associated with its active authorized goal.",
                "forbidden",
              ),
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
          .pipe(
            Effect.mapError(
              toServiceError("Failed to disable coordinator after project deletion."),
            ),
          );
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
      Stream.unwrap(
        Effect.gen(function* () {
          const matchesProject = (event: ProjectAgentStreamEvent) => {
            if (event.type === "snapshot") return event.overview.projectId === input.projectId;
            if (event.type === "config-upserted") return event.config.projectId === input.projectId;
            if (event.type === "goal-upserted") return event.goal.projectId === input.projectId;
            if (event.type === "task-upserted") return event.task.projectId === input.projectId;
            if (event.type === "activity-appended")
              return event.activity.projectId === input.projectId;
            if (event.type === "digest-upserted") return event.digest.projectId === input.projectId;
            return event.head.projectId === input.projectId;
          };
          const liveQueue = yield* Queue.bounded<ProjectAgentStreamEvent, Cause.Done>(64);
          yield* Stream.fromPubSub(events).pipe(
            Stream.filter(matchesProject),
            Stream.runIntoQueue(liveQueue),
            Effect.forkScoped,
          );
          const overview = yield* buildOverview(input.projectId);
          return Stream.concat(
            Stream.succeed({ type: "snapshot" as const, overview }),
            Stream.fromQueue(liveQueue),
          );
        }),
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
        const prerequisites = yield* Effect.forEach(task.dependsOnTaskIds, (id) =>
          repository
            .getTask(id)
            .pipe(Effect.mapError(toServiceError("Failed to load prerequisite task."))),
        );
        const ready = prerequisites.every(
          (option) => Option.isSome(option) && option.value.status === "done",
        );
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
        return yield* Effect.fail(
          fail("Goal controls require the user or coordinator.", "forbidden"),
        );
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
          .listTasks({
            projectId: input.projectId,
            goalId: saved.id,
            includeArchived: false,
            limit: 100,
          })
          .pipe(Effect.mapError(toServiceError("Failed to list managed workers.")));
        for (const task of tasks) {
          if (!task.assignedThreadId || task.status === "done" || task.status === "cancelled")
            continue;
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
    pauseGoal: (input, principal) =>
      updateGoalStatus(
        input,
        principal,
        "paused",
        "goal-paused",
        "Paused the project goal. Current tasks may settle.",
      ),
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
  } satisfies ProjectAgentServiceShape;
});

export const ProjectAgentServiceLive = Layer.effect(ProjectAgentService, makeProjectAgentService);
