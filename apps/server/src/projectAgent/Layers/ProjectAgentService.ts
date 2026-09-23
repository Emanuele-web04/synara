import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  AutomationId,
  CommandId,
  DEFAULT_PROJECT_AGENT_LIMITS,
  MessageId,
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
  coordinatorWelcomeDisplayName,
  coordinatorWelcomeMessageId,
  coordinatorWelcomeText,
  isGroupCoordinatorHostProject,
} from "../groupCoordinatorHost.ts";
import { assertLibraryRootLocation, moveLibraryRoot, resolveLibraryRoot } from "../libraryStore.ts";
import { withLibraryQueue, withLibraryRootLock } from "../libraryGit.ts";
import {
  canWriteMemoryDocument,
  decodeProjectAgentListCursor,
  detectProjectTaskDependencyCycle,
  encodeProjectAgentListCursor,
  INITIAL_PROJECT_DIGEST_SUMMARY,
  isCoordinatorCuratedDocumentPath,
  isGeneratedDocumentPath,
  isInboxDocumentPath,
  isMemoryDocumentPath,
  isMemoryThreadDocumentPath,
  isUserOwnedDocumentPath,
  MEMORY_AUTO_DOCUMENT_PATH,
  normalizeProjectDocumentPath,
  sanitizeProjectDigestSummary,
  truncateToContextBudget,
} from "@synara/shared/projectAgent";
import {
  Cause,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Semaphore,
  Stream,
} from "effect";

import { AutomationService } from "../../automation/Services/AutomationService.ts";
import { ServerConfig } from "../../config.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectAgentServiceError } from "../Errors.ts";
import { isAllowedGroupCoordinatorCreateTarget } from "../groupCreateAllowlist.ts";
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
import {
  PROJECT_BOT_HEARTBEAT_PROMPT,
  PROJECT_BOT_PLAYBOOK,
  PROJECT_BOT_PLAYBOOK_PATH,
  PROJECT_BOT_WATCH_RULES,
} from "../projectBotPlaybook.ts";
import {
  classifyWorkerSettlement,
  formatWorkerSettlementReport,
  formatWorkerWatchLine,
  isFailedWorkerSessionStatus,
  isWorkerAlertEvent,
  lastAssistantTextFromMessages,
  shouldMaterializeWorkerSettlementReport,
  workerInboxReportPath,
} from "../workerHealth.ts";
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
  message: (id = randomUUID()) => MessageId.makeUnsafe(id),
};

const SEED_DOCUMENTS: ReadonlyArray<{ path: string; content: string }> = [
  {
    path: "overview.md",
    content: "# Overview\n\nCoordinator is not configured.\n",
  },
  { path: "instructions.md", content: "# Instructions\n\n" },
  { path: "notes.md", content: "# Notes\n\n" },
  { path: "decisions.md", content: "# Decisions\n\n" },
  { path: "archived.md", content: "# Archived\n\n" },
  { path: "artifacts/index.md", content: "# Artifacts\n\n" },
  { path: PROJECT_BOT_PLAYBOOK_PATH, content: PROJECT_BOT_PLAYBOOK },
  { path: "internal/manifest.json", content: "{}\n" },
  {
    path: MEMORY_AUTO_DOCUMENT_PATH,
    content: "# Memory\n\nCurated memory. Threads write their own notes under memory/threads/.\n",
  },
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

  // Per-project serialization: the wake check-then-act, configure, and the
  // health-check dispatch paths all read-then-write the same coordinator
  // state, so they run under one keyed semaphore per project.
  const projectLocks = new Map<ProjectId, Semaphore.Semaphore>();
  const projectLockFor = (projectId: ProjectId) => {
    const existing = projectLocks.get(projectId);
    if (existing) return existing;
    const created = Effect.runSync(Semaphore.make(1));
    projectLocks.set(projectId, created);
    return created;
  };
  const withProjectLock = <A, E, R>(projectId: ProjectId, effect: Effect.Effect<A, E, R>) =>
    projectLockFor(projectId).withPermits(1)(effect);

  const clearWakeCursor = (
    projectId: ProjectId,
    cursor: {
      readonly processedThroughInboxId: string | null;
      readonly processedThroughCreatedAt: string | null;
    },
  ) =>
    repository
      .saveCursor({
        projectId,
        processedThroughInboxId: cursor.processedThroughInboxId,
        processedThroughCreatedAt: cursor.processedThroughCreatedAt,
        frozenFromInboxId: null,
        frozenToInboxId: null,
        coordinatorBusy: false,
        coordinatorBusySince: null,
        updatedAt: isoNow(),
      })
      .pipe(Effect.mapError(toServiceError("Failed to release the coordinator busy marker.")));

  // Worker threads are the ones the coordinator assigned to a task — NOT every
  // indexed group thread (which includes ordinary user chats in the group).
  const assignedWorkerThreadIds = (projectId: ProjectId) =>
    repository.listTasks({ projectId, includeArchived: false, limit: 500 }).pipe(
      Effect.map(
        (tasks) =>
          new Set(
            tasks
              .map((task) => task.assignedThreadId)
              .filter((threadId): threadId is ThreadId => threadId !== null),
          ),
      ),
      Effect.mapError(toServiceError("Failed to load worker assignments.")),
    );

  // A digest left "running" by a crash or restart would block refresh forever;
  // reset those rows once at startup so the next schedule regenerates them.
  yield* repository.resetInterruptedDigests().pipe(Effect.catch(() => Effect.succeed(0)));

  const requireOrdinaryRepoProject = (projectId: ProjectId) =>
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
                  fail("Only ordinary repositories can be linked to a group.", "forbidden"),
                );
          },
        }),
      ),
    );

  const assertAbsoluteLibraryPath = (value: string) => {
    if (!path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
      return Effect.fail(
        fail("libraryPath must be an absolute path without '..' segments.", "invalid"),
      );
    }
    return Effect.void;
  };

  const resolveGroupCoordinatorProject = (projectId: ProjectId) =>
    snapshotQuery.getProjectShellById(projectId).pipe(
      Effect.mapError(toServiceError("Failed to load project.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail(`Project "${projectId}" was not found.`, "not-found")),
          onSome: (project) => {
            const allowed = isGroupCoordinatorHostProject({
              kind: project.kind,
              workspaceRoot: project.workspaceRoot,
              groupsWorkspaceRoot: serverConfig.groupsWorkspaceRoot,
              studioWorkspaceRoot: serverConfig.studioWorkspaceRoot,
            });
            return allowed
              ? Effect.succeed(project)
              : Effect.fail(fail("The coordinator is only available on groups.", "forbidden"));
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
      // The repository allocates the sequence inside the INSERT itself so two
      // fibers cannot race MAX+1 onto the same (project_id, sequence) key.
      const saved = yield* repository
        .appendActivity({ ...input, id: branded.activity() })
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
        .writeDocument({
          revision,
          expectedRevision: null,
          diskHash: revision.contentHash,
        })
        .pipe(Effect.mapError(toServiceError("Failed to write project document.")));
      yield* writeProjectDocumentMirror({
        stateDir: serverConfig.stateDir,
        projectId,
        logicalPath,
        content,
      }).pipe(Effect.mapError(toServiceError("Failed to materialize project document.")));
      return saved;
    });

  const upsertSystemDocument = (input: {
    readonly projectId: ProjectId;
    readonly logicalPath: string;
    readonly content: string;
    readonly sources?: ProjectDocumentRevision["sources"];
    readonly authorThreadId?: ThreadId | null;
  }) =>
    Effect.gen(function* () {
      const logicalPath = normalizeProjectDocumentPath(input.logicalPath);
      const head = yield* repository
        .getDocumentHead(input.projectId, logicalPath)
        .pipe(Effect.mapError(toServiceError("Failed to load document head.")));
      const currentRevision = Option.isSome(head) ? head.value.revision : 0;
      if (Option.isSome(head) && head.value.contentHash === hashDocumentContent(input.content)) {
        return;
      }
      const now = isoNow();
      const revision: ProjectDocumentRevision = {
        id: branded.document(),
        projectId: input.projectId,
        logicalPath,
        revision: currentRevision + 1,
        content: input.content,
        contentHash: hashDocumentContent(input.content),
        authorKind: "system",
        authorThreadId: input.authorThreadId ?? null,
        sources: input.sources ?? [],
        createdAt: now,
      };
      const saved = yield* repository
        .writeDocument({
          revision,
          expectedRevision: currentRevision === 0 ? null : currentRevision,
          diskHash: revision.contentHash,
        })
        .pipe(Effect.mapError(toServiceError("Failed to write project document.")));
      yield* writeProjectDocumentMirror({
        stateDir: serverConfig.stateDir,
        projectId: input.projectId,
        logicalPath,
        content: input.content,
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
      return saved;
    });

  const ensureProjectBotPlaybook = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const existingPlaybook = yield* repository
        .readDocumentRevision({
          projectId,
          logicalPath: PROJECT_BOT_PLAYBOOK_PATH,
        })
        .pipe(Effect.mapError(toServiceError("Failed to load project bot playbook.")));
      if (Option.isNone(existingPlaybook)) {
        yield* writeSeedDocument(
          projectId,
          PROJECT_BOT_PLAYBOOK_PATH,
          PROJECT_BOT_PLAYBOOK,
          "system",
        );
        return;
      }
      if (
        existingPlaybook.value.content === PROJECT_BOT_PLAYBOOK ||
        existingPlaybook.value.authorKind !== "system"
      ) {
        return;
      }
      const now = isoNow();
      const revision: ProjectDocumentRevision = {
        id: branded.document(),
        projectId,
        logicalPath: PROJECT_BOT_PLAYBOOK_PATH,
        revision: existingPlaybook.value.revision + 1,
        content: PROJECT_BOT_PLAYBOOK,
        contentHash: hashDocumentContent(PROJECT_BOT_PLAYBOOK),
        authorKind: "system",
        authorThreadId: null,
        sources: [],
        createdAt: now,
      };
      yield* repository
        .writeDocument({
          revision,
          expectedRevision: existingPlaybook.value.revision,
          diskHash: revision.contentHash,
        })
        .pipe(Effect.mapError(toServiceError("Failed to refresh project bot playbook.")));
      yield* writeProjectDocumentMirror({
        stateDir: serverConfig.stateDir,
        projectId,
        logicalPath: PROJECT_BOT_PLAYBOOK_PATH,
        content: PROJECT_BOT_PLAYBOOK,
      }).pipe(Effect.mapError(toServiceError("Failed to materialize project bot playbook.")));
    });

  const ensureProjectBotHeartbeat = (config: ProjectAgentConfig) =>
    Effect.gen(function* () {
      if (!config.automationId) return;
      const listed = yield* automationService
        .list({ projectId: config.projectId })
        .pipe(Effect.mapError(toServiceError("Failed to load project heartbeat.")));
      const current = listed.definitions.find(
        (definition) => definition.id === config.automationId,
      );
      if (!current || current.prompt === PROJECT_BOT_HEARTBEAT_PROMPT) return;
      yield* automationService
        .update({
          id: config.automationId,
          prompt: PROJECT_BOT_HEARTBEAT_PROMPT,
        })
        .pipe(Effect.mapError(toServiceError("Failed to refresh project heartbeat.")));
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
      const existingByThreadId = new Map(existing.map((entry) => [entry.threadId, entry] as const));
      const persistent = threads.filter((thread) => thread.deletedAt === null);
      const sorted = [...persistent].toSorted((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
      let assignedCoverage = coveredIds.size;
      for (const thread of sorted) {
        const prior = existingByThreadId.get(thread.threadId);
        const excluded = excludedIds.has(thread.threadId);
        const alreadyCovered = coveredIds.has(thread.threadId);
        const covered =
          alreadyCovered ||
          (!excluded && assignedCoverage < PROJECT_AGENT_INITIAL_SUMMARY_THREAD_COUNT);
        if (covered && !alreadyCovered && !excluded) assignedCoverage += 1;
        // Only write when something actually changed: this runs inside every
        // digest refresh, and unconditional upserts reset lastSummarizedAt and
        // churn the row for every indexed thread each time.
        const next = {
          projectId,
          threadId: thread.threadId,
          excluded,
          archived: thread.archivedAt !== null,
          summaryStatus: excluded
            ? ("skipped" as const)
            : covered
              ? ("covered" as const)
              : ("pending" as const),
          lastUpdatedAt: thread.updatedAt,
          lastSummarizedAt: covered
            ? (prior?.lastSummarizedAt ?? isoNow())
            : (prior?.lastSummarizedAt ?? null),
        };
        const unchanged =
          prior !== undefined &&
          prior.excluded === next.excluded &&
          prior.archived === next.archived &&
          prior.summaryStatus === next.summaryStatus &&
          prior.lastUpdatedAt === next.lastUpdatedAt &&
          prior.lastSummarizedAt === next.lastSummarizedAt;
        if (unchanged) continue;
        yield* repository
          .upsertThreadIndex(next)
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
    principal?: ProjectAgentPrincipal,
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
      let digestValue = Option.getOrNull(digest);
      if (digestValue) {
        const sanitized = sanitizeProjectDigestSummary(digestValue.summary);
        if (sanitized && sanitized !== digestValue.summary) {
          digestValue = { ...digestValue, summary: sanitized };
          yield* repository
            .saveDigest(digestValue)
            .pipe(Effect.mapError(toServiceError("Failed to repair project digest.")));
          yield* publish({ type: "digest-upserted", digest: digestValue });
        }
      }
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
      // Library hosting fields (remote URL may carry credentials) are only
      // surfaced to the user; agent principals get the config without them.
      const visibleConfig =
        principal !== undefined && principal.kind !== "user"
          ? (() => {
              const {
                libraryPath: _libraryPath,
                libraryRemoteUrl: _libraryRemoteUrl,
                libraryPushOnChange: _libraryPushOnChange,
                ...rest
              } = config.value;
              return rest;
            })()
          : config.value;
      return {
        projectId,
        configured: true,
        config: visibleConfig,
        goal: goalValue,
        digest: digestValue,
        blockers,
        recentOutcomes: activity,
        coordinatorStatus: coordinatorStatusFromGoal(true, goalValue?.status ?? null),
      };
    });

  const replayReceipt = <A>(requestId: string, projectId: ProjectId, decode: (json: string) => A) =>
    repository.getReceipt({ requestId, projectId }).pipe(
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

  const requireProjectAccess = (principal: ProjectAgentPrincipal, projectId: ProjectId) =>
    assertSameProject(principal, projectId).pipe(
      Effect.andThen(resolveGroupCoordinatorProject(projectId)),
      Effect.asVoid,
    );

  const importCoordinatorGreeting = (input: {
    readonly threadId: ThreadId;
    readonly userDisplayName?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const messageId = coordinatorWelcomeMessageId(input.threadId);
      const detail = yield* snapshotQuery
        .getThreadDetailById(input.threadId)
        .pipe(Effect.mapError(toServiceError("Failed to load coordinator thread.")));
      const alreadyImported =
        Option.isSome(detail) && detail.value.messages.some((message) => message.id === messageId);
      if (alreadyImported) return;
      const greetingAt = isoNow();
      const welcomeName = coordinatorWelcomeDisplayName({
        userDisplayName: input.userDisplayName,
        homeDir: serverConfig.homeDir,
      });
      yield* orchestrationEngine
        .dispatch({
          type: "thread.messages.import",
          commandId: branded.command(),
          threadId: input.threadId,
          messages: [
            {
              messageId,
              role: "assistant",
              text: coordinatorWelcomeText(welcomeName),
              createdAt: greetingAt,
              updatedAt: greetingAt,
            },
          ],
          createdAt: greetingAt,
        })
        .pipe(Effect.mapError(toServiceError("Failed to persist the coordinator greeting.")));
    });

  const generateDigestNow = (projectId: ProjectId) =>
    Effect.gen(function* () {
      // Claim the inflight slot atomically: two callers must not both pass
      // the check-then-set and run the same generation twice.
      const claimed = yield* Ref.modify(digestInflight, (current) =>
        current.has(projectId)
          ? ([false, current] as const)
          : ([true, new Set(current).add(projectId)] as const),
      );
      if (!claimed) {
        yield* Ref.update(digestPending, (pending) => new Set(pending).add(projectId));
        return;
      }
      yield* Ref.update(digestPending, (pending) => {
        const next = new Set(pending);
        next.delete(projectId);
        return next;
      });
      const previous = yield* repository
        .getDigest(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load digest.")));
      const lastGood = Option.isSome(previous) ? previous.value : null;
      const previousSummary = sanitizeProjectDigestSummary(lastGood?.summary);
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
        summary: previousSummary ?? "Generating project summary…",
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
          previousSummary: previousSummary ?? undefined,
          activity: activity.map((entry) => `${entry.id}: ${entry.summary}`).join("\n"),
          coverage: `summarized=${coverage.summarizedThreadCount} pending=${coverage.pendingThreadCount}`,
          pinnedFocus: (lastGood?.focusItems ?? [])
            .filter((item) => item.pinned)
            .map((item) => item.title)
            .join("\n"),
        })
        .pipe(
          Effect.map((result) => ({
            summary: sanitizeProjectDigestSummary(result.summary) ?? INITIAL_PROJECT_DIGEST_SUMMARY,
            focusItems: mergePinnedFocusItems(
              validateDigestFocusItems(result.focusItems, allowed),
              (lastGood?.focusItems ?? []).filter((item) => item.pinned),
            ),
            error: null as string | null,
          })),
          Effect.catch((error) =>
            Effect.succeed({
              summary:
                previousSummary ??
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
      // Work that arrived while this generation ran stays flagged in
      // digestPending; the owning drain loop (timer or caller) picks it up.
    }).pipe(
      // A failure mid-run must not leave the digest row stuck in "running":
      // mark it failed so later schedules know to regenerate.
      Effect.onError(() =>
        repository.getDigest(projectId).pipe(
          Effect.flatMap((digest) =>
            Option.isSome(digest) && digest.value.generationState === "running"
              ? repository
                  .saveDigest({
                    ...digest.value,
                    generationState: "failed",
                    lastError: "Digest generation was interrupted.",
                  })
                  .pipe(Effect.catch(() => Effect.void))
              : Effect.void,
          ),
          Effect.catch(() => Effect.void),
        ),
      ),
      Effect.ensuring(
        Ref.update(digestInflight, (current) => {
          const next = new Set(current);
          next.delete(projectId);
          return next;
        }),
      ),
    );

  // Runs generations until the pending flag for this project stays clear:
  // a schedule that lands mid-run queues another pass instead of being
  // dropped while the timer still holds its slot.
  const runDigestQueue = (projectId: ProjectId) =>
    Effect.gen(function* () {
      for (;;) {
        yield* generateDigestNow(projectId).pipe(Effect.catch(() => Effect.void));
        const pending = yield* Ref.get(digestPending);
        if (!pending.has(projectId)) return;
        yield* Ref.update(digestPending, (set) => {
          const next = new Set(set);
          next.delete(projectId);
          return next;
        });
      }
    });

  const impl: ProjectAgentServiceShape = {
    getOverview: (input, principal) =>
      requireProjectAccess(principal, input.projectId).pipe(
        Effect.andThen(buildOverview(input.projectId, principal)),
      ),

    listSummaries: (_input, principal) =>
      repository.listSummaries().pipe(
        Effect.mapError(toServiceError("Failed to list project agents.")),
        Effect.flatMap((rows) =>
          Effect.gen(function* () {
            const shells = yield* snapshotQuery
              .getProjectShellsByIds(rows.map((row) => row.projectId))
              .pipe(Effect.mapError(toServiceError("Failed to list project agents.")));
            const shellById = new Map(shells.map((shell) => [shell.id, shell] as const));
            const visible: ProjectAgentSummary[] = [];
            for (const row of rows) {
              const shell = shellById.get(row.projectId);
              if (!shell) continue;
              if (
                !isGroupCoordinatorHostProject({
                  kind: shell.kind,
                  workspaceRoot: shell.workspaceRoot,
                  groupsWorkspaceRoot: serverConfig.groupsWorkspaceRoot,
                  studioWorkspaceRoot: serverConfig.studioWorkspaceRoot,
                })
              ) {
                continue;
              }
              visible.push({
                projectId: row.projectId,
                configured: true,
                coordinatorName: row.coordinatorName,
                coordinatorThreadId: row.coordinatorThreadId,
                coordinatorIcon: row.coordinatorIcon,
                coordinatorColor: row.coordinatorColor,
                coordinatorStatus: coordinatorStatusFromGoal(true, row.goalStatus),
                revision: row.revision,
              });
            }
            return {
              summaries: [...projectAgentSummariesForPrincipal(visible, principal)],
            };
          }),
        ),
      ),

    configure: (input, principal) =>
      // Serialized per project: two concurrent first configures would otherwise
      // each create an orphan coordinator thread, and a retry after a partial
      // failure must reuse what the first attempt already made.
      withProjectLock(
        input.projectId,
        Effect.gen(function* () {
          if (!canConfigureProject(principal)) {
            return yield* Effect.fail(
              fail("Only the user can configure Project Coordinator.", "forbidden"),
            );
          }
          const existingReceipt = yield* replayReceipt(
            input.requestId,
            input.projectId,
            (json) => JSON.parse(json) as ProjectAgentOverview,
          );
          if (existingReceipt) return existingReceipt;
          const project = yield* resolveGroupCoordinatorProject(input.projectId);
          const existing = yield* repository
            .getConfig(input.projectId)
            .pipe(Effect.mapError(toServiceError("Failed to load project coordinator.")));
          const now = isoNow();
          const coordinatorName = input.coordinatorName ?? `${project.title} Coordinator`;
          let coordinatorThreadId: ThreadId;
          let automationId: ProjectAgentConfig["automationId"];
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
            automationId = null;
            // A previous attempt may have created the coordinator thread but died
            // before the config save; adopt it instead of orphaning a second one.
            const threads = yield* projectionThreads
              .listByProjectId({ projectId: input.projectId })
              .pipe(Effect.mapError(toServiceError("Failed to list project threads.")));
            const reusable = threads.find(
              (thread) => thread.deletedAt === null && thread.title === coordinatorName,
            );
            coordinatorThreadId =
              reusable?.threadId ??
              (yield* createCoordinatorThread({
                projectId: input.projectId,
                title: coordinatorName,
                modelSelection: input.coordinatorModelSelection,
              }));
          }
          if (!automationId) {
            // Same idempotency for the heartbeat automation: if a past attempt
            // created it before failing, adopt its id rather than duplicating it.
            const listed = yield* automationService
              .list({ projectId: input.projectId })
              .pipe(Effect.mapError(toServiceError("Failed to load project heartbeat.")));
            automationId =
              listed.definitions.find(
                (definition) =>
                  definition.mode === "heartbeat" &&
                  definition.schedule.type === "project-event" &&
                  definition.sourceThreadId === coordinatorThreadId,
              )?.id ?? null;
          }
          const existingConfig = Option.isSome(existing) ? existing.value : null;
          if (input.libraryPath !== undefined && input.libraryPath !== null) {
            yield* assertAbsoluteLibraryPath(input.libraryPath);
          }
          const config: ProjectAgentConfig = {
            projectId: input.projectId,
            coordinatorThreadId,
            coordinatorName,
            coordinatorModelSelection: input.coordinatorModelSelection,
            // Omitted fields keep their stored values; `null` clears (handled
            // per-field below for the clearable ones).
            ...(input.coordinatorProviderOptions
              ? { coordinatorProviderOptions: input.coordinatorProviderOptions }
              : existingConfig?.coordinatorProviderOptions
                ? { coordinatorProviderOptions: existingConfig.coordinatorProviderOptions }
                : {}),
            ...(input.workerRouting
              ? { workerRouting: input.workerRouting }
              : existingConfig?.workerRouting
                ? { workerRouting: existingConfig.workerRouting }
                : {}),
            limits: input.limits ?? existingConfig?.limits ?? { ...DEFAULT_PROJECT_AGENT_LIMITS },
            captureEnabled: input.captureEnabled ?? existingConfig?.captureEnabled ?? true,
            enabled: true,
            automationId,
            revision,
            createdAt: existingConfig?.createdAt ?? now,
            updatedAt: now,
            disabledAt: null,
            ...(input.goal !== undefined
              ? { goal: input.goal }
              : existingConfig?.goal
                ? { goal: existingConfig.goal }
                : {}),
            // `null` clears the field; absent keeps the stored value.
            ...(input.icon === null
              ? {}
              : input.icon !== undefined
                ? { icon: input.icon }
                : existingConfig?.icon
                  ? { icon: existingConfig.icon }
                  : {}),
            ...(input.coordinatorIcon === null
              ? {}
              : input.coordinatorIcon !== undefined
                ? { coordinatorIcon: input.coordinatorIcon }
                : existingConfig?.coordinatorIcon
                  ? { coordinatorIcon: existingConfig.coordinatorIcon }
                  : {}),
            ...(input.coordinatorColor === null
              ? {}
              : input.coordinatorColor !== undefined
                ? { coordinatorColor: input.coordinatorColor }
                : existingConfig?.coordinatorColor
                  ? { coordinatorColor: existingConfig.coordinatorColor }
                  : {}),
            autoMemoryEnabled:
              input.autoMemoryEnabled ?? existingConfig?.autoMemoryEnabled ?? false,
            linkedProjectIds: existingConfig?.linkedProjectIds ?? [],
            ...(input.libraryPath === null
              ? {}
              : input.libraryPath !== undefined
                ? { libraryPath: input.libraryPath }
                : existingConfig?.libraryPath
                  ? { libraryPath: existingConfig.libraryPath }
                  : {}),
            ...(input.libraryRemoteUrl === null
              ? {}
              : input.libraryRemoteUrl !== undefined
                ? { libraryRemoteUrl: input.libraryRemoteUrl }
                : existingConfig?.libraryRemoteUrl
                  ? { libraryRemoteUrl: existingConfig.libraryRemoteUrl }
                  : {}),
            libraryPushOnChange:
              input.libraryPushOnChange ?? existingConfig?.libraryPushOnChange ?? false,
          };
          const expectedConfigRevision = Option.isSome(existing) ? existing.value.revision : null;
          // Changing libraryPath relocates the store: copy the whole tree
          // (including .git history) to the new root and persist the config
          // inside the same root lock so a concurrent upload can neither write
          // into the tree mid-copy nor resolve a stale root after the repoint.
          const saved = yield* input.libraryPath !== undefined &&
          input.libraryPath !== existingConfig?.libraryPath
            ? withLibraryRootLock(
                input.projectId,
                Effect.gen(function* () {
                  const previousRoot = yield* resolveLibraryRoot({
                    stateDir: serverConfig.stateDir,
                    projectId: input.projectId,
                    libraryPath: existingConfig?.libraryPath,
                  }).pipe(
                    Effect.mapError(toServiceError("Failed to resolve the current library.")),
                  );
                  const nextRoot = yield* resolveLibraryRoot({
                    stateDir: serverConfig.stateDir,
                    projectId: input.projectId,
                    // `null` clears to the default per-project library root.
                    libraryPath: input.libraryPath ?? undefined,
                  }).pipe(Effect.mapError(toServiceError("Failed to resolve the new library.")));
                  yield* assertLibraryRootLocation({
                    root: nextRoot,
                    stateDir: serverConfig.stateDir,
                    groupsWorkspaceRoot: serverConfig.groupsWorkspaceRoot,
                    studioWorkspaceRoot: serverConfig.studioWorkspaceRoot,
                    isCustomPath: true,
                  }).pipe(
                    Effect.mapError(toServiceError("Failed to validate the new library path.")),
                  );
                  const moveResult = yield* withLibraryQueue(
                    previousRoot,
                    withLibraryQueue(
                      nextRoot,
                      moveLibraryRoot({ fromRoot: previousRoot, toRoot: nextRoot }),
                    ),
                  ).pipe(
                    Effect.mapError((cause) =>
                      fail(`Could not move the group library: ${cause.message}`, "invalid"),
                    ),
                  );
                  if (moveResult.moved) {
                    yield* Effect.logInfo(
                      `moved the group library from ${previousRoot} to ${nextRoot}`,
                    );
                  }
                  return yield* repository
                    .saveConfig(config, expectedConfigRevision)
                    .pipe(
                      Effect.mapError(toServiceError("Failed to save coordinator configuration.")),
                    );
                }),
              )
            : repository
                .saveConfig(config, expectedConfigRevision)
                .pipe(Effect.mapError(toServiceError("Failed to save coordinator configuration.")));
          const documentHeads = yield* repository
            .listDocumentHeads(input.projectId)
            .pipe(Effect.mapError(toServiceError("Failed to list project documents.")));
          if (documentHeads.length === 0) {
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
                summary: INITIAL_PROJECT_DIGEST_SUMMARY,
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
          }
          yield* importCoordinatorGreeting({
            threadId: coordinatorThreadId,
            userDisplayName: input.userDisplayName,
          });
          if (!saved.automationId) {
            const automation = yield* automationService
              .createProjectManaged({
                projectId: input.projectId,
                sourceThreadId: coordinatorThreadId,
                name: `${coordinatorName} events`,
                prompt: PROJECT_BOT_HEARTBEAT_PROMPT,
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
          const latestConfig = yield* requireConfig(input.projectId);
          yield* ensureProjectBotHeartbeat(latestConfig).pipe(Effect.catch(() => Effect.void));
          // Publish the persisted row (with automationId and the real revision),
          // not the pre-link `saved` snapshot.
          yield* publish({ type: "config-upserted", config: latestConfig });
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
              : "Configured Project Coordinator.",
            createdAt: now,
          });
          const overview = yield* buildOverview(input.projectId);
          yield* storeReceipt(input.requestId, input.projectId, "configure", overview);
          return overview;
        }),
      ),

    linkProject: (input, principal) =>
      Effect.gen(function* () {
        if (!isUserPrincipal(principal)) {
          return yield* Effect.fail(fail("Linking a repository is a user action.", "forbidden"));
        }
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          input.projectId,
          (json) => JSON.parse(json) as ProjectAgentOverview,
        );
        if (existingReceipt) return existingReceipt;
        yield* resolveGroupCoordinatorProject(input.projectId);
        if (input.linkedProjectId === input.projectId) {
          return yield* Effect.fail(fail("A group cannot link to itself.", "invalid"));
        }
        const linked = yield* requireOrdinaryRepoProject(input.linkedProjectId);
        const currentIds = yield* repository
          .listLinkedProjectIds(input.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to list linked repositories.")));
        if (!currentIds.includes(input.linkedProjectId)) {
          yield* repository
            .linkProject({
              projectId: input.projectId,
              linkedProjectId: input.linkedProjectId,
              createdAt: isoNow(),
            })
            .pipe(Effect.mapError(toServiceError("Failed to link repository.")));
          yield* appendActivity({
            projectId: input.projectId,
            kind: "config-updated",
            actorKind: "user",
            actorThreadId: null,
            goalId: null,
            taskId: null,
            source: null,
            summary: `Linked repository ${linked.title}`,
            createdAt: isoNow(),
          });
        }
        const config = yield* requireConfig(input.projectId);
        yield* publish({ type: "config-upserted", config });
        const overview = yield* buildOverview(input.projectId);
        yield* storeReceipt(input.requestId, input.projectId, "linkProject", overview);
        return overview;
      }),

    unlinkProject: (input, principal) =>
      Effect.gen(function* () {
        if (!isUserPrincipal(principal)) {
          return yield* Effect.fail(fail("Unlinking a repository is a user action.", "forbidden"));
        }
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          input.projectId,
          (json) => JSON.parse(json) as ProjectAgentOverview,
        );
        if (existingReceipt) return existingReceipt;
        yield* resolveGroupCoordinatorProject(input.projectId);
        const currentIds = yield* repository
          .listLinkedProjectIds(input.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to list linked repositories.")));
        if (currentIds.includes(input.linkedProjectId)) {
          const linkedShell = yield* snapshotQuery
            .getProjectShellById(input.linkedProjectId)
            .pipe(Effect.mapError(toServiceError("Failed to load linked project.")));
          const title = Option.isSome(linkedShell)
            ? linkedShell.value.title
            : String(input.linkedProjectId);
          yield* repository
            .unlinkProject({
              projectId: input.projectId,
              linkedProjectId: input.linkedProjectId,
            })
            .pipe(Effect.mapError(toServiceError("Failed to unlink repository.")));
          yield* appendActivity({
            projectId: input.projectId,
            kind: "config-updated",
            actorKind: "user",
            actorThreadId: null,
            goalId: null,
            taskId: null,
            source: null,
            summary: `Unlinked repository ${title}`,
            createdAt: isoNow(),
          });
        }
        const config = yield* requireConfig(input.projectId);
        yield* publish({ type: "config-upserted", config });
        const overview = yield* buildOverview(input.projectId);
        yield* storeReceipt(input.requestId, input.projectId, "unlinkProject", overview);
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
          input.projectId,
          (json) => JSON.parse(json) as ProjectGoal,
        );
        if (existingReceipt) return existingReceipt;
        yield* resolveGroupCoordinatorProject(input.projectId);
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
          input.projectId,
          (json) => JSON.parse(json) as ProjectGoal,
        );
        if (existingReceipt) return existingReceipt;
        yield* resolveGroupCoordinatorProject(input.projectId);
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
      requireProjectAccess(principal, input.projectId).pipe(
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
            tasks.length === (input.limit ?? 50)
              ? encodeProjectAgentListCursor({
                  createdAt: tasks[tasks.length - 1]!.createdAt,
                  id: tasks[tasks.length - 1]!.id,
                })
              : null,
        })),
      ),

    createTask: (input, principal) =>
      Effect.gen(function* () {
        yield* requireProjectAccess(principal, input.projectId);
        if (!canAcceptTask(principal, input.projectId) && principal.kind !== "coordinator") {
          return yield* Effect.fail(fail("Workers cannot create tasks.", "forbidden"));
        }
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          input.projectId,
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
        yield* requireProjectAccess(principal, input.projectId);
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          input.projectId,
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
        // A worker may only update the task it was assigned; every other
        // principal may update any task in the project (project access was
        // already checked above).
        if (principal.kind === "worker" && principal.taskId !== current.id) {
          return yield* Effect.fail(
            fail("A worker can only update the task it was assigned.", "forbidden"),
          );
        }
        // "done" is routed through the same acceptance path as accept=true so
        // it also requires evidence and unblocks dependents.
        const wantsAccept = input.accept === true || input.status === "done";
        if (wantsAccept) {
          if (!canAcceptTask(principal, input.projectId)) {
            return yield* Effect.fail(
              fail(
                principal.kind === "worker"
                  ? "A finished provider turn updates an attempt. It cannot mark a task done."
                  : "A worker cannot mark a task accepted. Acceptance requires the coordinator or user.",
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
          // Dependencies must point at tasks in the same project (same check
          // createTask performs).
          for (const dependencyId of dependsOnTaskIds) {
            const dependency = yield* repository
              .getTask(dependencyId)
              .pipe(Effect.mapError(toServiceError("Failed to load a task dependency.")));
            if (Option.isNone(dependency) || dependency.value.projectId !== input.projectId) {
              return yield* Effect.fail(
                fail("Task dependencies must belong to the same project.", "invalid"),
              );
            }
          }
        }
        const nextStatus: ProjectTaskStatus = wantsAccept
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
        if (wantsAccept) {
          yield* unblockDependents(saved);
        }
        yield* publish({ type: "task-upserted", task: saved });
        yield* appendActivity({
          projectId: input.projectId,
          kind: wantsAccept ? "task-accepted" : "task-updated",
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
          summary: wantsAccept ? `Accepted task: ${saved.title}` : `Updated task: ${saved.title}`,
          createdAt: saved.updatedAt,
        });
        yield* storeReceipt(input.requestId, input.projectId, "updateTask", saved);
        return saved;
      }),

    listActivity: (input, principal) =>
      requireProjectAccess(principal, input.projectId).pipe(
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
            activity.length === (input.limit ?? 50)
              ? encodeProjectAgentListCursor({
                  createdAt: activity[activity.length - 1]!.createdAt,
                  id: activity[activity.length - 1]!.id,
                  // Activity pages by sequence (the sort key), not timestamps.
                  sequence: activity[activity.length - 1]!.sequence,
                })
              : null,
        })),
      ),

    listDocuments: (input, principal) =>
      requireProjectAccess(principal, input.projectId).pipe(
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
        yield* requireProjectAccess(principal, input.projectId);
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
        // External change = the file differs from the disk state the DB last
        // synced (diskHash marker; legacy heads fall back to the content hash).
        const syncedMarker = head.diskHash ?? head.contentHash;
        const conflictPending =
          diskHash !== null && diskHash !== syncedMarker && diskHash !== head.contentHash;
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
        yield* requireProjectAccess(principal, input.projectId);
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          input.projectId,
          (json) => JSON.parse(json) as ProjectDocumentRevision,
        );
        if (existingReceipt) return existingReceipt;
        const logicalPath = normalizeProjectDocumentPath(input.logicalPath);
        if (isMemoryDocumentPath(logicalPath)) {
          const allowed = canWriteMemoryDocument({
            logicalPath,
            principalKind: principal.kind,
            principalThreadId: principal.kind === "user" ? null : principal.threadId,
          });
          if (!allowed) {
            return yield* Effect.fail(
              fail("This principal cannot write that memory document.", "forbidden"),
            );
          }
          if (
            logicalPath === MEMORY_AUTO_DOCUMENT_PATH &&
            principal.kind !== "user" &&
            input.expectedRevision === undefined
          ) {
            return yield* Effect.fail(
              fail("Coordinator memory writes require the latest revision.", "conflict"),
            );
          }
        } else if (isGeneratedDocumentPath(logicalPath) && principal.kind !== "user") {
          return yield* Effect.fail(
            fail("Generated views cannot be overwritten directly.", "forbidden"),
          );
        }
        if (isUserOwnedDocumentPath(logicalPath) && !canWriteUserOwnedDocuments(principal)) {
          return yield* Effect.fail(
            fail("Only the user can edit project instructions and notes.", "forbidden"),
          );
        }
        if (isInboxDocumentPath(logicalPath)) {
          const allowed =
            principal.kind === "user" ||
            principal.kind === "coordinator" ||
            (principal.kind === "worker" && logicalPath.startsWith(`inbox/${principal.threadId}/`));
          if (!allowed) {
            return yield* Effect.fail(
              fail("Workers can only write their own inbox entries.", "forbidden"),
            );
          }
        }
        // Curated docs (decisions.md, docs/**) are written by the user and the
        // coordinator only — never by workers, group members, or unmanaged threads.
        if (
          isCoordinatorCuratedDocumentPath(logicalPath) &&
          principal.kind !== "user" &&
          principal.kind !== "coordinator"
        ) {
          return yield* Effect.fail(
            fail(
              "Only the user or the coordinator can rewrite curated project knowledge.",
              "forbidden",
            ),
          );
        }
        // Unmanaged threads and plain group members get no write access outside
        // the memory tree (their own-thread memory file was handled above).
        if (
          (principal.kind === "group-member" || principal.kind === "unmanaged") &&
          !isMemoryDocumentPath(logicalPath)
        ) {
          return yield* Effect.fail(
            fail("This thread has no write access to project documents.", "forbidden"),
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
        // External change = the file differs from the disk state the DB last
        // synced (diskHash marker; legacy heads fall back to contentHash). A
        // stale mirror from a previous failed materialize is NOT an external
        // change — the write below simply overwrites it.
        if (Option.isSome(head) && !input.importExternal && diskHash !== null) {
          const syncedMarker = head.value.diskHash ?? head.value.contentHash;
          if (diskHash !== syncedMarker && diskHash !== head.value.contentHash) {
            return yield* Effect.fail(
              fail(
                "The Markdown file changed outside Synara. Import the external copy explicitly instead of overwriting it.",
                "conflict",
              ),
            );
          }
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
            // Keep the previous disk marker until the mirror write below
            // confirms; a failed materialize then leaves head.diskHash equal
            // to the real file state instead of pretending it synced.
            diskHash: Option.isSome(head) ? head.value.diskHash : revision.contentHash,
            conflictPending: false,
          })
          .pipe(Effect.mapError(toServiceError("Failed to write project document.")));
        yield* writeProjectDocumentMirror({
          stateDir: serverConfig.stateDir,
          projectId: input.projectId,
          logicalPath,
          content,
        }).pipe(Effect.mapError(toServiceError("Failed to materialize project document.")));
        yield* repository
          .markDocumentDiskSynced({
            projectId: input.projectId,
            logicalPath,
            diskHash: revision.contentHash,
          })
          .pipe(Effect.mapError(toServiceError("Failed to record the synced document.")));
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
        yield* resolveGroupCoordinatorProject(input.projectId);
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
        yield* requireProjectAccess(principal, input.projectId);
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
          Effect.andThen(runDigestQueue(projectId)),
          Effect.catch(() => Effect.void),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Ref.update(digestTimer, (current) => {
                const next = new Set(current);
                next.delete(projectId);
                return next;
              });
              // A schedule that landed between the last pending check and the
              // timer release must not be dropped: re-arm so it is picked up.
              const pending = yield* Ref.get(digestPending);
              if (pending.has(projectId)) {
                yield* impl.scheduleDigest(projectId);
              }
            }),
          ),
          Effect.forkChild,
        );
      }).pipe(Effect.asVoid),

    listEvidence: (input, principal) =>
      Effect.gen(function* () {
        yield* requireProjectAccess(principal, input.projectId);
        const task = yield* repository.getTask(input.taskId).pipe(
          Effect.mapError(toServiceError("Failed to load project task.")),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(fail("Task was not found.", "not-found")),
              onSome: Effect.succeed,
            }),
          ),
        );
        if (task.projectId !== input.projectId) {
          return yield* Effect.fail(fail("Task does not belong to this project.", "forbidden"));
        }
        const evidence = yield* repository
          .listEvidenceForTask(input.taskId)
          .pipe(Effect.mapError(toServiceError("Failed to list task evidence.")));
        return { evidence };
      }),

    listThreadIndex: (input, principal) =>
      requireProjectAccess(principal, input.projectId).pipe(
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
        yield* resolveGroupCoordinatorProject(input.projectId);
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
        yield* resolveGroupCoordinatorProject(input.projectId);
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
        const isCoordinatorLike = principal.kind === "coordinator" || principal.kind === "worker";
        // Every thread in a group gets the group's instructions and memory;
        // unmanaged threads outside groups get nothing.
        if (!isCoordinatorLike && principal.kind !== "group-member") {
          return "";
        }
        const config = yield* repository
          .getConfig(principal.projectId)
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        if (principal.kind === "coordinator") {
          yield* ensureProjectBotPlaybook(principal.projectId).pipe(
            Effect.catch(() => Effect.void),
          );
          if (Option.isSome(config)) {
            yield* ensureProjectBotHeartbeat(config.value).pipe(Effect.catch(() => Effect.void));
          }
        }
        const packet = yield* impl.buildContextPacket(principal.projectId, threadId);
        const playbook = yield* repository
          .readDocumentRevision({
            projectId: principal.projectId,
            logicalPath: PROJECT_BOT_PLAYBOOK_PATH,
          })
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        const coordinatorThreadId = Option.isSome(config) ? config.value.coordinatorThreadId : null;
        // Batched worker context: one read for thread shells and one for all
        // report docs instead of two lookups per worker per turn.
        const assigned = isCoordinatorLike
          ? yield* assignedWorkerThreadIds(principal.projectId).pipe(
              Effect.catch(() => Effect.succeed(new Set<ThreadId>())),
            )
          : new Set<ThreadId>();
        const workerThreadIds = [...assigned].filter((id) => id !== coordinatorThreadId);
        const workerShells =
          workerThreadIds.length > 0
            ? yield* snapshotQuery
                .getThreadShellsByIds(workerThreadIds)
                .pipe(Effect.catch(() => Effect.succeed([])))
            : [];
        const workerShellById = new Map(workerShells.map((shell) => [shell.id, shell] as const));
        const workerLines: string[] = [];
        for (const workerThreadId of workerThreadIds) {
          const shell = workerShellById.get(workerThreadId);
          workerLines.push(
            formatWorkerWatchLine({
              title: shell?.title ?? "Worker thread",
              status: shell?.session?.status ?? "missing",
              lastError: shell?.session?.lastError ?? "thread is gone",
            }),
          );
        }
        const reports =
          workerThreadIds.length > 0
            ? yield* repository
                .readDocumentRevisions({
                  projectId: principal.projectId,
                  logicalPaths: workerThreadIds.map((id) => workerInboxReportPath(id)),
                })
                .pipe(Effect.catch(() => Effect.succeed([])))
            : [];
        const workerReports = reports
          .map((report) => report.content.trim())
          .filter((content) => content.length > 0);
        const groupGoal = Option.isSome(config) ? config.value.goal?.trim() : "";
        const memoryEnabled = Option.isSome(config)
          ? Boolean(config.value.autoMemoryEnabled)
          : false;
        const memoryHeads = memoryEnabled
          ? (yield* repository
              .listDocumentHeads(principal.projectId)
              .pipe(Effect.catch(() => Effect.succeed([]))))
              .filter(
                (head) =>
                  head.logicalPath === MEMORY_AUTO_DOCUMENT_PATH ||
                  isMemoryThreadDocumentPath(head.logicalPath),
              )
              .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          : [];
        const memoryDocuments =
          memoryHeads.length > 0
            ? yield* repository
                .readDocumentRevisions({
                  projectId: principal.projectId,
                  logicalPaths: memoryHeads.map((head) => head.logicalPath),
                })
                .pipe(Effect.catch(() => Effect.succeed([])))
            : [];
        const memoryByPath = new Map(
          memoryDocuments.map((document) => [document.logicalPath, document.content] as const),
        );
        const memorySections: string[] = [];
        for (const head of memoryHeads) {
          const content = memoryByPath.get(head.logicalPath)?.trim();
          if (content) {
            memorySections.push(`### ${head.logicalPath}\n${content}`);
          }
        }
        const budget = truncateToContextBudget([
          ...(isCoordinatorLike
            ? [
                {
                  label: "Playbook",
                  text: Option.isSome(playbook) ? playbook.value.content : PROJECT_BOT_PLAYBOOK,
                },
              ]
            : []),
          ...(groupGoal ? [{ label: "Objective", text: groupGoal }] : []),
          ...(memoryEnabled ? [{ label: "Memory", text: memorySections.join("\n\n") }] : []),
          {
            label: "Linked repositories",
            text: yield* Effect.gen(function* () {
              const linkedIds = Option.isSome(config) ? (config.value.linkedProjectIds ?? []) : [];
              if (linkedIds.length === 0) return "None linked yet.";
              const shells = yield* snapshotQuery
                .getProjectShellsByIds(linkedIds)
                .pipe(Effect.catch(() => Effect.succeed([])));
              if (shells.length === 0) return "None linked yet.";
              return shells.map((shell) => `- ${shell.title} (${shell.workspaceRoot})`).join("\n");
            }),
          },
          ...(isCoordinatorLike ? [{ label: "Watch", text: PROJECT_BOT_WATCH_RULES }] : []),
          ...(isCoordinatorLike
            ? [
                {
                  label: "Workers",
                  text:
                    workerLines.length > 0
                      ? `${workerLines.join("\n")}\nIf a worker is error/interrupted/stopped, redelegate or choose an alternate. Do not wait.`
                      : "No workers yet.",
                },
                {
                  label: "Worker reports",
                  text:
                    workerReports.length > 0
                      ? workerReports.join("\n\n")
                      : "None yet. Synara writes inbox/<threadId>/report.md when a worker finishes or dies.",
                },
              ]
            : []),
          {
            label: "Goal",
            text: packet.goal?.objective ?? "None. Only create a goal if the user asked for one.",
          },
          { label: "Instructions", text: packet.instructions },
          { label: "Decisions", text: packet.relevantDecisions },
          {
            label: "Tasks",
            text: packet.tasks.map((task) => `- ${task.status} ${task.title}`).join("\n"),
          },
        ]);
        return [
          "Project context packet (authoritative durable state; additional documents via synara_project_read_document):",
          "This thread opened with a welcome message from you; the user may be replying to it.",
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
        const config = yield* requireConfig(principal.projectId);
        // The user's configured limits apply, clamped to the hard caps — the
        // defaults act as the ceiling, not a floor the user cannot go below.
        const limits = {
          maxNewWorkersPerTurn: Math.min(
            config.limits.maxNewWorkersPerTurn,
            DEFAULT_PROJECT_AGENT_LIMITS.maxNewWorkersPerTurn,
          ),
          maxConcurrentWorkers: Math.min(
            config.limits.maxConcurrentWorkers,
            DEFAULT_PROJECT_AGENT_LIMITS.maxConcurrentWorkers,
          ),
        };
        const running = yield* repository
          .countRunningWorkers(principal.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to count running workers.")));
        if (input.requestedCount > limits.maxNewWorkersPerTurn) {
          return yield* Effect.fail(
            fail(
              `This project allows at most ${limits.maxNewWorkersPerTurn} new workers per turn.`,
              "limit",
            ),
          );
        }
        if (running + input.requestedCount > limits.maxConcurrentWorkers) {
          return yield* Effect.fail(
            fail(
              `This project allows at most ${limits.maxConcurrentWorkers} concurrent workers.`,
              "limit",
            ),
          );
        }
      }),

    recordManagedWorkerThreads: (input) =>
      Effect.gen(function* () {
        const principal = yield* impl.resolvePrincipalForThread(input.callerThreadId);
        if (principal.kind !== "coordinator") return;
        const now = isoNow();
        const goal = yield* repository
          .getActiveGoal(principal.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load authorized goal.")));
        const activeGoal =
          Option.isSome(goal) && goal.value.status === "active" ? goal.value : null;
        for (const [index, threadId] of input.threadIds.entries()) {
          const title = input.titles[index] ?? `Worker ${index + 1}`;
          yield* repository
            .upsertThreadIndex({
              projectId: principal.projectId,
              threadId,
              excluded: false,
              archived: false,
              summaryStatus: "pending",
              lastUpdatedAt: now,
              lastSummarizedAt: null,
            })
            .pipe(Effect.mapError(toServiceError("Failed to index worker thread.")));
          if (activeGoal) {
            const task = yield* impl.createTask(
              {
                requestId: `${input.requestId}:task:${threadId}`,
                projectId: principal.projectId,
                goalId: activeGoal.id,
                title,
                dependsOnTaskIds: [],
              },
              principal,
            );
            // createTask's receipt replay may return a stale revision; reload
            // the row before writing the assignment on top of it.
            const currentTask = yield* repository.getTask(task.id).pipe(
              Effect.mapError(toServiceError("Failed to reload worker task.")),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(fail("Task was not found.", "not-found")),
                  onSome: Effect.succeed,
                }),
              ),
            );
            const assigned = {
              ...currentTask,
              status: "running" as const,
              assignedThreadId: threadId,
              revision: currentTask.revision + 1,
              updatedAt: now,
            };
            yield* repository
              .saveTask(assigned, currentTask.revision)
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
                createdAt: now,
                finishedAt: null,
              })
              .pipe(Effect.mapError(toServiceError("Failed to record worker attempt.")));
          }
          yield* appendActivity({
            projectId: principal.projectId,
            kind: "task-created",
            actorKind: "coordinator",
            actorThreadId: principal.threadId,
            goalId: activeGoal?.id ?? null,
            taskId: null,
            source: null,
            summary: `Opened worker: ${title}`,
            createdAt: now,
          });
        }
        if (activeGoal) {
          // processPendingWakes may bump this goal concurrently — reload the
          // latest row each attempt so a revision conflict just retries.
          const bumpWorkerCount = Effect.gen(function* () {
            const latest = yield* repository
              .getGoal(activeGoal.id)
              .pipe(Effect.mapError(toServiceError("Failed to reload authorized goal.")));
            if (Option.isNone(latest)) return;
            yield* repository
              .saveGoal(
                {
                  ...latest.value,
                  workerCreationCount: latest.value.workerCreationCount + input.threadIds.length,
                  revision: latest.value.revision + 1,
                  updatedAt: now,
                },
                latest.value.revision,
              )
              .pipe(Effect.mapError(toServiceError("Failed to count worker creations.")));
          });
          yield* bumpWorkerCount.pipe(
            Effect.retry({
              times: 2,
              while: (error) =>
                error instanceof ProjectAgentServiceError && error.code === "conflict",
            }),
          );
        }
        yield* impl.scheduleDigest(principal.projectId);
      }),

    reconcilePendingWakes: () =>
      Effect.gen(function* () {
        const configs = yield* repository
          .listConfigs()
          .pipe(Effect.mapError(toServiceError("Failed to list project coordinators.")));
        const shells = yield* snapshotQuery
          .getProjectShellsByIds(configs.map((config) => config.projectId))
          .pipe(Effect.mapError(toServiceError("Failed to list project coordinators.")));
        const shellById = new Map(shells.map((shell) => [shell.id, shell] as const));
        for (const config of configs) {
          const shell = shellById.get(config.projectId);
          const isHost = Boolean(
            shell &&
            isGroupCoordinatorHostProject({
              kind: shell.kind,
              workspaceRoot: shell.workspaceRoot,
              groupsWorkspaceRoot: serverConfig.groupsWorkspaceRoot,
              studioWorkspaceRoot: serverConfig.studioWorkspaceRoot,
            }),
          );
          if (!isHost) {
            yield* Effect.gen(function* () {
              const latest = yield* repository
                .getConfig(config.projectId)
                .pipe(Effect.mapError(toServiceError("Failed to load leftover coordinator.")));
              if (Option.isNone(latest)) return;
              const current = latest.value;
              if (current.enabled) {
                const now = isoNow();
                const saved = yield* repository
                  .saveConfig(
                    {
                      ...current,
                      enabled: false,
                      revision: current.revision + 1,
                      updatedAt: now,
                      disabledAt: now,
                    },
                    current.revision,
                  )
                  .pipe(Effect.exit);
                if (Exit.isFailure(saved)) {
                  const again = yield* repository
                    .getConfig(config.projectId)
                    .pipe(Effect.mapError(toServiceError("Failed to load leftover coordinator.")));
                  if (Option.isNone(again) || again.value.enabled) {
                    return yield* Effect.failCause(saved.cause);
                  }
                }
                yield* appendActivity({
                  projectId: current.projectId,
                  kind: "config-updated",
                  actorKind: "system",
                  actorThreadId: null,
                  goalId: null,
                  taskId: null,
                  source: null,
                  summary: "Coordinator disabled: this project is not a group.",
                  createdAt: now,
                });
              }
              if (current.automationId) {
                yield* automationService
                  .update({ id: current.automationId, enabled: false })
                  .pipe(Effect.catch(() => Effect.void));
              }
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to disable leftover coordinator", {
                  projectId: config.projectId,
                  error: String(error),
                }),
              ),
            );
            continue;
          }
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
        yield* requireProjectAccess(principal, input.projectId);
        const task = yield* repository.getTask(input.taskId).pipe(
          Effect.mapError(toServiceError("Failed to load project task.")),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(fail("Task was not found.", "not-found")),
              onSome: Effect.succeed,
            }),
          ),
        );
        if (task.projectId !== input.projectId) {
          return yield* Effect.fail(fail("Task does not belong to this project.", "forbidden"));
        }
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

    buildContextPacket: (projectId, threadId) =>
      Effect.gen(function* () {
        // Resolve the caller and require access to the project — any agent
        // thread must not read another group's goal, instructions, or tasks.
        const principal = yield* impl.resolvePrincipalForThread(threadId);
        yield* requireProjectAccess(principal, projectId);
        yield* requireConfig(projectId);
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
          .readDocumentRevision({
            projectId,
            logicalPath: PROJECT_BOT_PLAYBOOK_PATH,
          })
          .pipe(Effect.mapError(toServiceError("Failed to load project bot playbook.")));
        const tasks = yield* repository
          .listTasks({ projectId, includeArchived: false, limit: 40 })
          .pipe(Effect.mapError(toServiceError("Failed to load tasks for context.")));
        const digest = yield* repository
          .getDigest(projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load digest coverage.")));
        const sections = [
          { label: "Watch", text: PROJECT_BOT_WATCH_RULES },
          {
            label: "Goal",
            text: Option.isSome(goal)
              ? goal.value.objective
              : "None. Only create a goal if the user asked for one.",
          },
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
        const shell = yield* snapshotQuery
          .getThreadShellById(input.threadId)
          .pipe(Effect.mapError(toServiceError("Failed to resolve thread for event.")));
        const projectId = Option.isSome(task)
          ? task.value.projectId
          : Option.isSome(configByCoordinator)
            ? configByCoordinator.value.projectId
            : Option.isSome(shell)
              ? shell.value.projectId
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
        // A worker is a thread the coordinator assigned to a task. Wakes come
        // from those threads or from any group thread that ends in an alert
        // (error / needs the user) — never from routine turns in group chats.
        const managedWorker = Option.isSome(task);
        const eligibleWake = managedWorker || isWorkerAlertEvent(input.eventType);
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
        const shouldReport =
          managedWorker && shouldMaterializeWorkerSettlementReport(input.eventType);
        let reportRewritten = false;
        if (shouldReport) {
          const detail = yield* snapshotQuery
            .getThreadDetailById(input.threadId)
            .pipe(Effect.catch(() => Effect.succeed(Option.none())));
          const title = Option.isSome(detail)
            ? detail.value.title
            : Option.isSome(shell)
              ? shell.value.title
              : "Worker thread";
          const lastAssistantText = Option.isSome(detail)
            ? lastAssistantTextFromMessages(detail.value.messages)
            : null;
          const outcome = classifyWorkerSettlement({
            eventType: input.eventType,
            sessionStatus: Option.isSome(shell) ? shell.value.session?.status : null,
          });
          const report = formatWorkerSettlementReport({
            title,
            threadId: input.threadId,
            eventType: input.eventType,
            status: Option.isSome(shell) ? shell.value.session?.status : null,
            lastError: Option.isSome(shell) ? shell.value.session?.lastError : null,
            lastAssistantText,
          });
          const written = yield* upsertSystemDocument({
            projectId,
            logicalPath: workerInboxReportPath(input.threadId),
            content: report,
            authorThreadId: input.threadId,
            sources: [
              {
                threadId: input.threadId,
                path: workerInboxReportPath(input.threadId),
              },
            ],
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
          reportRewritten = written !== undefined;
          if (inserted.inserted || reportRewritten) {
            yield* appendActivity({
              projectId,
              kind: "document-written",
              actorKind: "system",
              actorThreadId: input.threadId,
              goalId: Option.isSome(task) ? task.value.goalId : null,
              taskId: Option.isSome(task) ? task.value.id : null,
              source: {
                path: workerInboxReportPath(input.threadId),
                threadId: input.threadId,
              },
              summary: `Worker ${title} reported: ${outcome}.`,
              createdAt: input.createdAt,
            }).pipe(Effect.catch(() => Effect.void));
          }
          if (Option.isSome(task) && (inserted.inserted || reportRewritten)) {
            yield* repository
              .saveEvidence({
                id: branded.evidence(),
                projectId,
                taskId: task.value.id,
                attemptId: null,
                kind: "message",
                classification: "reported",
                authorKind: "system",
                authorThreadId: input.threadId,
                sourceThreadId: input.threadId,
                sourceMessageId: null,
                sourceTurnId: Option.isSome(detail)
                  ? (detail.value.latestTurn?.turnId ?? null)
                  : null,
                summary: report.slice(0, 4_000).trim() || "Worker settlement report.",
                createdAt: input.createdAt,
              })
              .pipe(Effect.catch(() => Effect.void));
          }
        }
        if (!inserted.inserted) {
          if (reportRewritten) {
            yield* impl.scheduleDigest(projectId);
          }
          return;
        }
        yield* impl.scheduleDigest(projectId);
        if (eligibleWake) {
          yield* impl.processPendingWakes(projectId);
        }
      }),

    processPendingWakes: (projectId) =>
      // Serialized per project: the busy check, freeze, and cursor advance are
      // one atomic unit — the event handler and the health-check timer would
      // otherwise both dispatch the same wake.
      withProjectLock(
        projectId,
        Effect.gen(function* () {
          const config = yield* requireConfig(projectId);
          const goal = yield* repository
            .getActiveGoal(projectId)
            .pipe(Effect.mapError(toServiceError("Failed to load goal for wake.")));
          const activeGoal =
            Option.isSome(goal) && goal.value.status === "active" ? goal.value : null;
          if (
            activeGoal &&
            activeGoal.continuationCount >= activeGoal.limits.maxAutomaticContinuationsPerGoal
          ) {
            yield* repository
              .saveGoal(
                {
                  ...activeGoal,
                  status: "paused",
                  revision: activeGoal.revision + 1,
                  updatedAt: isoNow(),
                },
                activeGoal.revision,
              )
              .pipe(Effect.mapError(toServiceError("Failed to pause exhausted goal.")));
            yield* appendActivity({
              projectId,
              kind: "goal-paused",
              actorKind: "system",
              actorThreadId: null,
              goalId: activeGoal.id,
              taskId: null,
              source: null,
              summary:
                "Automatic coordinator continuations reached the goal limit. Resume after reviewing outcomes.",
              createdAt: isoNow(),
            });
            return;
          }
          let cursor = yield* repository
            .getCursor(projectId)
            .pipe(Effect.mapError(toServiceError("Failed to load project event cursor.")));
          if (
            cursor.coordinatorBusy &&
            cursor.frozenFromInboxId !== null &&
            cursor.frozenToInboxId !== null
          ) {
            // Recovery path: the process died (or runNow failed) after freezing
            // this range. Re-drive the SAME receipt id — if a run was already
            // dispatched its id sits in the receipt and we just advance.
            const fromInboxId = cursor.frozenFromInboxId;
            const toInboxId = cursor.frozenToInboxId;
            const receiptId = wakeReceiptRequestId({ projectId, fromInboxId, toInboxId });
            const existingWake = yield* repository
              .getReceipt({ requestId: receiptId, projectId })
              .pipe(Effect.mapError(toServiceError("Failed to load wake receipt.")));
            let runId = Option.isSome(existingWake)
              ? (JSON.parse(existingWake.value.resultJson) as { runId?: string }).runId
              : undefined;
            if (!runId) {
              if (!config.automationId) {
                yield* clearWakeCursor(projectId, cursor);
                return;
              }
              const run = yield* automationService
                .runNow({ automationId: config.automationId })
                .pipe(
                  Effect.mapError(toServiceError("Failed to dispatch coordinator continuation.")),
                );
              runId = run.run.id;
              yield* storeReceipt(receiptId, projectId, "wake", { runId });
              if (activeGoal) {
                yield* repository
                  .saveGoal(
                    {
                      ...activeGoal,
                      continuationCount: activeGoal.continuationCount + 1,
                      revision: activeGoal.revision + 1,
                      updatedAt: isoNow(),
                    },
                    activeGoal.revision,
                  )
                  .pipe(
                    Effect.mapError(toServiceError("Failed to count coordinator continuation.")),
                  );
              }
            }
            // The keyset cursor needs the frozen range's last row's createdAt.
            const tail = yield* repository
              .listInboxAfter({
                projectId,
                afterCreatedAt: cursor.processedThroughCreatedAt,
                afterId: cursor.processedThroughInboxId,
                limit: 500,
              })
              .pipe(Effect.mapError(toServiceError("Failed to load project inbox.")));
            const toRow = tail.find((event) => event.id === toInboxId);
            yield* repository
              .saveCursor({
                projectId,
                processedThroughInboxId: toInboxId,
                processedThroughCreatedAt: toRow?.createdAt ?? cursor.processedThroughCreatedAt,
                frozenFromInboxId: null,
                frozenToInboxId: null,
                coordinatorBusy: false,
                coordinatorBusySince: null,
                updatedAt: isoNow(),
              })
              .pipe(Effect.mapError(toServiceError("Failed to advance project event cursor.")));
            yield* appendActivity({
              projectId,
              kind: "wake-enqueued",
              actorKind: "system",
              actorThreadId: config.coordinatorThreadId,
              goalId: activeGoal?.id ?? null,
              taskId: null,
              source: null,
              summary: `Resumed interrupted coordinator continuation ${runId}.`,
              createdAt: isoNow(),
            });
            yield* impl.scheduleDigest(projectId);
            return;
          }
          if (cursor.coordinatorBusy) {
            // Busy with no frozen range means a crash between the busy mark and
            // the freeze — clear it so events are not stuck forever.
            yield* clearWakeCursor(projectId, cursor);
            cursor = { ...cursor, coordinatorBusy: false, coordinatorBusySince: null };
          }
          const pending = yield* repository
            .listInboxAfter({
              projectId,
              afterCreatedAt: cursor.processedThroughCreatedAt,
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
            .getReceipt({ requestId: receiptId, projectId })
            .pipe(Effect.mapError(toServiceError("Failed to load wake receipt.")));
          yield* repository
            .saveCursor({
              projectId,
              processedThroughInboxId: cursor.processedThroughInboxId,
              processedThroughCreatedAt: cursor.processedThroughCreatedAt,
              frozenFromInboxId: fromInboxId,
              frozenToInboxId: toInboxId,
              coordinatorBusy: true,
              coordinatorBusySince: isoNow(),
              updatedAt: isoNow(),
            })
            .pipe(Effect.mapError(toServiceError("Failed to freeze project event range.")));
          let runId = Option.isSome(existingWake)
            ? (JSON.parse(existingWake.value.resultJson) as { runId?: string }).runId
            : undefined;
          if (!runId) {
            const run = yield* automationService
              .runNow({ automationId: config.automationId })
              .pipe(
                Effect.mapError(toServiceError("Failed to dispatch coordinator continuation.")),
              );
            runId = run.run.id;
            yield* storeReceipt(receiptId, projectId, "wake", { runId });
            if (activeGoal) {
              yield* repository
                .saveGoal(
                  {
                    ...activeGoal,
                    continuationCount: activeGoal.continuationCount + 1,
                    revision: activeGoal.revision + 1,
                    updatedAt: isoNow(),
                  },
                  activeGoal.revision,
                )
                .pipe(Effect.mapError(toServiceError("Failed to count coordinator continuation.")));
            }
          }
          yield* repository
            .saveCursor({
              projectId,
              processedThroughInboxId: toInboxId,
              processedThroughCreatedAt: eligible[eligible.length - 1]!.createdAt,
              frozenFromInboxId: null,
              frozenToInboxId: null,
              coordinatorBusy: false,
              coordinatorBusySince: null,
              updatedAt: isoNow(),
            })
            .pipe(Effect.mapError(toServiceError("Failed to advance project event cursor.")));
          yield* appendActivity({
            projectId,
            kind: "wake-enqueued",
            actorKind: "system",
            actorThreadId: config.coordinatorThreadId,
            goalId: activeGoal?.id ?? null,
            taskId: eligible[0]?.taskId ?? null,
            source: null,
            summary: `Dispatched coordinator continuation ${runId}. Later events remain queued.`,
            createdAt: isoNow(),
          });
          yield* impl.scheduleDigest(projectId);
        }).pipe(
          // Any failure while a range is frozen must release the busy flag;
          // otherwise every future wake bails on coordinatorBusy forever.
          Effect.onError(() =>
            repository.getCursor(projectId).pipe(
              Effect.flatMap((latest) => clearWakeCursor(projectId, latest)),
              Effect.catch(() => Effect.void),
            ),
          ),
        ),
      ),

    inspectWorkerHealth: () =>
      Effect.gen(function* () {
        const configs = yield* repository
          .listConfigs()
          .pipe(Effect.mapError(toServiceError("Failed to list project coordinators.")));
        for (const config of configs) {
          if (!config.enabled) continue;
          // Only task-assigned threads are workers. Ordinary group chats stay
          // indexed for context but a healthy idle/finished one must never
          // produce reports, wakes, or digests.
          const workerThreadIds = yield* assignedWorkerThreadIds(config.projectId);
          for (const threadId of workerThreadIds) {
            if (threadId === config.coordinatorThreadId) {
              continue;
            }
            const shell = yield* snapshotQuery
              .getThreadShellById(threadId)
              .pipe(Effect.catch(() => Effect.succeed(Option.none())));
            if (Option.isNone(shell)) {
              yield* impl.ingestSettledThreadEvent({
                threadId,
                sourceEventId: `worker-health:${threadId}:missing`,
                eventType: "worker.missing",
                createdAt: isoNow(),
              });
              continue;
            }
            const status = shell.value.session?.status ?? null;
            if (!isFailedWorkerSessionStatus(status)) continue;
            const updatedAt = shell.value.session?.updatedAt ?? shell.value.updatedAt;
            yield* impl.ingestSettledThreadEvent({
              threadId,
              sourceEventId: `worker-health:${threadId}:${status}:${updatedAt}`,
              eventType: `worker.${status}`,
              createdAt: isoNow(),
            });
          }
        }
      }),

    resolvePrincipalForThread: (threadId) =>
      Effect.gen(function* () {
        const coordinator = yield* repository
          .getConfigByCoordinatorThread(threadId)
          .pipe(Effect.mapError(toServiceError("Failed to resolve coordinator principal.")));
        if (Option.isSome(coordinator)) {
          yield* resolveGroupCoordinatorProject(coordinator.value.projectId);
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
          yield* resolveGroupCoordinatorProject(task.value.projectId);
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
        // Every thread living in a group is a group member: it gets the
        // group's instructions and memory, may write its own memory file, and
        // reads curated docs — it cannot rewrite them.
        const hostProject = yield* resolveGroupCoordinatorProject(shell.value.projectId).pipe(
          Effect.option,
        );
        if (Option.isSome(hostProject)) {
          const config = yield* repository
            .getConfig(shell.value.projectId)
            .pipe(Effect.mapError(toServiceError("Failed to resolve group coordinator.")));
          if (Option.isSome(config)) {
            return {
              kind: "group-member" as const,
              threadId,
              projectId: shell.value.projectId,
            };
          }
        }
        // Threads a group created outside its own project (e.g. linked-repo
        // workers whose task already ended) still belong to that group when
        // the thread index recorded them.
        const configs = yield* repository
          .listConfigs()
          .pipe(Effect.mapError(toServiceError("Failed to resolve group membership.")));
        for (const config of configs) {
          const index = yield* repository
            .listThreadIndex(config.projectId)
            .pipe(Effect.mapError(toServiceError("Failed to resolve group membership.")));
          if (index.some((entry) => entry.threadId === threadId)) {
            return {
              kind: "group-member" as const,
              threadId,
              projectId: config.projectId,
            };
          }
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
          if (targetShell.projectId !== caller.projectId) {
            return yield* Effect.fail(fail("Cross-project control is blocked.", "forbidden"));
          }
        }
      }),

    assertCallerMayCreateThreadInProject: (input) =>
      Effect.gen(function* () {
        const caller = yield* impl.resolvePrincipalForThread(input.callerThreadId);
        if (caller.kind !== "coordinator") return;
        const config = yield* requireConfig(caller.projectId);
        const linkedProjectIds = config.linkedProjectIds ?? [];
        if (
          isAllowedGroupCoordinatorCreateTarget({
            targetProjectId: input.targetProjectId,
            groupProjectId: caller.projectId,
            linkedProjectIds,
          })
        ) {
          return;
        }
        const allowedIds = [caller.projectId, ...linkedProjectIds];
        const shells = yield* snapshotQuery
          .getProjectShellsByIds(allowedIds)
          .pipe(Effect.catch(() => Effect.succeed([])));
        const allowed = shells.map((shell) => `${shell.title} (${shell.id})`).join(", ");
        return yield* Effect.fail(
          fail(
            `The coordinator can only create threads in this group or its linked repositories. Allowed: ${allowed || String(caller.projectId)}.`,
            "forbidden",
          ),
        );
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
          yield* resolveGroupCoordinatorProject(input.projectId);
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
        .listTasks({
          projectId: accepted.projectId,
          includeArchived: false,
          limit: 100,
        })
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
      yield* resolveGroupCoordinatorProject(input.projectId);
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
      // A stopped goal is terminal: resuming it would silently reopen scope
      // the user explicitly closed.
      if (status === "active" && current.status === "stopped") {
        return yield* Effect.fail(fail("A stopped goal cannot be resumed.", "invalid"));
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

  return impl satisfies ProjectAgentServiceShape;
});

export const ProjectAgentServiceLive = Layer.effect(ProjectAgentService, makeProjectAgentService);
