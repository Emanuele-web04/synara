import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  AutomationId,
  CommandId,
  DEFAULT_PROJECT_AGENT_LIMITS,
  EventId,
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
  PROVIDER_DISPLAY_NAMES,
  type OrchestrationCommand,
  type ProjectActivity,
  type ProjectActivityKind,
  type ProjectInboxEvent,
  type ProjectManagedWorker,
  type OrchestrationThreadShell,
  type LibraryEntry,
  type ProjectThreadIndexEntry,
  type ProjectAgentDeleteGroupResult,
  type ProjectAgentGroupThreadEntry,
  type ProjectAgentOverview,
  type ProjectAgentResolveWorkerInput,
  type ProjectAgentSummary,
  type ProjectAgentStreamEvent,
  type ProjectDocumentRevision,
  type ProjectTaskStatus,
  type ProviderSession,
} from "@synara/contracts";
import { groupThreadStateLabel, resolveGroupThreadState } from "@synara/shared/groupThreadState";
import { coordinatorCheckinTurnReport } from "@synara/shared/coordinatorCheckin";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import { isOrdinaryProjectRow } from "@synara/shared/projectContainers";
import {
  coordinatorWelcomeDisplayName,
  coordinatorWelcomeMessageId,
  coordinatorWelcomeText,
  isGroupCoordinatorHostProject,
} from "../groupCoordinatorHost.ts";
import {
  assertLibraryRootLocation,
  ensureLibraryRepo,
  isGitDirName,
  listLibraryEntries,
  moveLibraryRoot,
  normalizeLibraryRelativePath,
  resolveLibraryRoot,
  resolveLibraryWriteTarget,
} from "../libraryStore.ts";
import {
  commitLibraryChange,
  pushLibraryIfConfigured,
  withLibraryQueue,
  withLibraryQueues,
  withLibraryRootLock,
} from "../libraryGit.ts";
import { isContainedPath } from "../../workspace/realPathContainment.ts";
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
  isMemoryNoteDocumentPath,
  isMemoryThreadDocumentPath,
  isUserOwnedDocumentPath,
  MEMORY_AUTO_DOCUMENT_PATH,
  normalizeProjectDocumentPath,
  sanitizeProjectDigestSummary,
  truncateToContextBudget,
} from "@synara/shared/projectAgent";
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Equal,
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
import { ServerSettingsService } from "../../serverSettings.ts";
import { providerDisabledSettingsMessage } from "../../provider/enabledProviderAdapter.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  normalizeDigestError,
  ProjectAgentRepository,
} from "../../persistence/Services/ProjectAgentRepository.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { LibraryError, ProjectAgentServiceError } from "../Errors.ts";
import { isAllowedGroupCoordinatorCreateTarget } from "../groupCreateAllowlist.ts";
import { cleanupGroupWorkspaceRoot } from "../../groupWorkspaceScaffold.ts";
import {
  hashDocumentContent,
  materializeDocumentPath,
  projectContextRoot,
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
  formatWorkerBatchRollup,
  formatWorkerMonitorRow,
  formatWorkerSettlementReport,
  formatWorkerWatchLine,
  isFailedWorkerSessionStatus,
  isTerminalWorkerSettleOutcome,
  isWorkerAlertEvent,
  lastAssistantTextFromMessages,
  shouldMaterializeWorkerSettlementReport,
  WORKER_DISCONNECT_GRACE_MS,
  WORKER_NEVER_STARTED_MS,
  WORKER_RECOVERY_MAX_ATTEMPTS,
  WORKER_RECOVERY_NUDGE_TEXT,
  WORKER_RECOVERY_COMMAND_PREFIX,
  WORKER_RECOVERY_REDELIVER_DELAY_MS,
  WORKER_STUCK_RUNNING_QUIET_MS,
  WORKER_STUCK_WAITING_MS,
  WORKER_TOOL_OVERTIME_MS,
  WORKER_WAKE_EVENT_TYPES,
  workerInboxReportPath,
  workerMonitorNoticeForEvent,
} from "../workerHealth.ts";
import {
  ProjectAgentService,
  type ProjectAgentServiceShape,
} from "../Services/ProjectAgentService.ts";

const fail = (message: string, code?: ProjectAgentServiceError["code"]) =>
  new ProjectAgentServiceError({ message, ...(code ? { code } : {}) });

const isoNow = () => new Date().toISOString();

// A wake claim stays fresh long enough to cover crash-vs-slow dispatch; an
// expired claim means the earlier runNow threw and the range is re-dispatched.
const WAKE_CLAIM_TTL_MS = 10 * 60_000;
// A busy marker younger than this while the coordinator thread is mid-turn
// (or awaiting approvals) is live work, not a crash: recovery must not
// re-dispatch a second continuation on top of it.
const COORDINATOR_BUSY_LIVE_MS = 15 * 60_000;

// The dispatch claim for a wake range lives on a sibling receipt id —
// receipts are insert-only, so it is written before runNow and a crash
// between run start and receipt save can never queue a second run.
const wakeClaimRequestId = (receiptId: string) => `${receiptId}:claim`;

// Only dated note files are group memory the coordinator can forget; the
// index, thread-scoped memories, and user notes are off limits.
const GROUP_MEMORY_NOTE_PATTERN = /^memory\/\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/;
const MEMORY_INDEX_MAX_ENTRIES = 256;

const normalizeMemoryNote = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const memoryNoteBody = (content: string) => normalizeMemoryNote(content.replace(/^#[^\n]*\n/, ""));

const slugifyMemoryTitle = (value: string) => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "note";
};

const memoryNoteSummary = (note: string) =>
  note
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim()
    .slice(0, 140) ?? note.slice(0, 140);

// A memory title becomes both the `# heading` line and the single-line
// `- [title](path)` index entry — strip control characters so a title can
// never inject extra lines into MEMORY.md.
const sanitizeMemoryTitle = (value: string) =>
  value
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\x00-\x1F\x7F-\x9F]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

// Library adds walk the source with lstat at every step: symlinks are never
// followed (a swapped link cannot redirect the copy into or out of the
// workspace), `.git`/`node_modules` stay behind, and the walk is bounded so
// a runaway tree fails with a clear error instead of copying forever.
const LIBRARY_ADD_MAX_FILES = 10_000;
const LIBRARY_ADD_MAX_BYTES = 256 * 1024 * 1024;

class LibraryAddTooLargeError extends Error {}

const copyLibrarySourceTree = async (source: string, target: string) => {
  let fileCount = 0;
  let totalBytes = 0;
  const visit = async (src: string, dst: string, filterName: boolean): Promise<void> => {
    const stat = await fs.lstat(src);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      const name = path.basename(src);
      if (filterName && (isGitDirName(name) || name === "node_modules")) return;
      await fs.mkdir(dst, { recursive: true });
      for (const entry of await fs.readdir(src)) {
        await visit(path.join(src, entry), path.join(dst, entry), true);
      }
      return;
    }
    if (!stat.isFile()) return;
    fileCount += 1;
    totalBytes += stat.size;
    if (fileCount > LIBRARY_ADD_MAX_FILES) {
      throw new LibraryAddTooLargeError(
        `A library add is limited to ${LIBRARY_ADD_MAX_FILES} files.`,
      );
    }
    if (totalBytes > LIBRARY_ADD_MAX_BYTES) {
      throw new LibraryAddTooLargeError(
        `A library add is limited to ${Math.floor(LIBRARY_ADD_MAX_BYTES / (1024 * 1024))} MB total.`,
      );
    }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
  };
  await visit(source, target, false);
};

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

const SEED_INSTRUCTIONS_CONTENT = "# Instructions\n\n";
// listSummaries compares head hashes — the instructions body never leaves
// the document tables just to flag a customized file.
const SEED_INSTRUCTIONS_HASH = hashDocumentContent(SEED_INSTRUCTIONS_CONTENT);

const SEED_DOCUMENTS: ReadonlyArray<{ path: string; content: string }> = [
  {
    path: "overview.md",
    content: "# Overview\n\nCoordinator is not configured.\n",
  },
  { path: "instructions.md", content: SEED_INSTRUCTIONS_CONTENT },
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
  const serverSettingsService = yield* ServerSettingsService;
  const providerHealth = yield* ProviderHealth;
  const providerService = yield* ProviderService;
  const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
  const textGeneration = yield* TextGeneration;
  const git = yield* GitCore;
  const events = yield* PubSub.unbounded<ProjectAgentStreamEvent>();
  const digestInflight = yield* Ref.make(new Set<string>());
  const digestPending = yield* Ref.make(new Set<string>());
  const digestTimer = yield* Ref.make(new Set<string>());
  // The inputs a digest actually reads (activity minus bookkeeping rows,
  // tasks, threads, documents, coverage) hashed at generation time — a
  // refresh that finds the same signature is a no-op, so a coordinator turn
  // that changed nothing never burns a model call.
  const digestInputSignatures = yield* Ref.make(new Map<string, string>());

  const publish = (event: ProjectAgentStreamEvent) =>
    PubSub.publish(events, event).pipe(Effect.asVoid);
  // Index rows are the Overview Threads tab's data — a subscriber must see a
  // coordinator-spawned worker appear the moment it is indexed, not after the
  // next full listing (which may never come while the panel stays open).
  const publishThreadIndexUpserts = (
    projectId: ProjectId,
    threads: ReadonlyArray<ProjectThreadIndexEntry>,
  ) =>
    threads.length === 0
      ? Effect.void
      : publish({ type: "thread-index-upserted", projectId, threads: [...threads] });
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

  // Worker threads are the ones the coordinator tracks — NOT every indexed
  // group thread (which includes ordinary user chats in the group). The set
  // covers task-assigned threads plus every recorded managed worker, so
  // coordinator-created threads without an active goal are tracked too.
  const assignedWorkerThreadIds = (projectId: ProjectId) =>
    Effect.all({
      tasks: repository
        .listTasks({ projectId, includeArchived: false, limit: 500 })
        .pipe(Effect.mapError(toServiceError("Failed to load worker assignments."))),
      workers: repository
        .listManagedWorkers(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load managed workers."))),
    }).pipe(
      Effect.map(({ tasks, workers }) => {
        const ids = new Set<ThreadId>(workers.map((worker) => worker.threadId));
        for (const task of tasks) {
          if (task.assignedThreadId !== null) ids.add(task.assignedThreadId);
        }
        return ids;
      }),
    );

  // Compact system rows the server posts into the coordinator thread when a
  // tracked worker settles or goes stuck — deterministic monitoring, not an
  // LLM message. Rows carry deterministic command/activity ids so a replayed
  // ingest or command receipt can never double-post.
  const postWorkerMonitorRow = (input: {
    readonly coordinatorThreadId: ThreadId;
    readonly sourceKey: string;
    readonly tone: "info" | "approval" | "error";
    readonly kind: string;
    readonly summary: string;
    readonly payload: Record<string, unknown>;
    readonly createdAt: string;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`agent-monitor:${input.sourceKey}`),
        threadId: input.coordinatorThreadId,
        activity: {
          id: EventId.makeUnsafe(`agent-monitor:${input.sourceKey}`),
          tone: input.tone,
          kind: input.kind,
          summary: input.summary,
          payload: JSON.parse(JSON.stringify(input.payload)),
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(Effect.catch(() => Effect.void));

  // Apply one settle/stuck event to a managed worker: post the compact system
  // row into the coordinator thread, update the durable worker row, then post
  // the all-workers roll-up once every worker in the creation batch has
  // settled (deduped by the batch's outcome signature so it fires once per
  // distinct settled state).
  const recordWorkerMonitorEvent = (input: {
    readonly worker: ProjectManagedWorker;
    readonly eventType: string;
    readonly sourceEventId: string;
    readonly createdAt: string;
    readonly coordinatorThreadId: ThreadId;
    readonly taskId: ProjectTaskId | null;
    /** Paused/archived groups keep recording worker state but post no rows. */
    readonly suppressRows?: boolean;
    /** Tracked PR association for the worker thread, when one exists. */
    readonly lastKnownPr?: { readonly url: string } | null;
  }) =>
    Effect.gen(function* () {
      const notice = workerMonitorNoticeForEvent(input.eventType);
      if (notice === null) return;
      const worker = input.worker;
      // A terminal settle already reported: same-episode re-ingests — a
      // replayed stop or the health loop's status pass — must not post a
      // second row, and a settled worker cannot go stuck. A genuinely new
      // terminal transition (missing → completed) still reports.
      if (
        isTerminalWorkerSettleOutcome(worker.settleOutcome) &&
        (notice.kind === "stuck" || notice.outcome === worker.settleOutcome)
      ) {
        return;
      }
      // The worker's structured report beats the generic outcome phrase —
      // "Shipped the migration, 12 files changed" over "finished".
      const resultPhrase = (() => {
        const line = worker.resultSummary?.split("\n")[0]?.trim();
        if (line) return line.length > 140 ? `${line.slice(0, 137)}...` : line;
        // A finished worker that never filed a structured result gets the
        // gap noted inline so nobody has to open the thread to check.
        if (notice.outcome === "completed") return `${notice.phrase} — no result filed`;
        return notice.phrase;
      })();
      const prUrl = input.lastKnownPr?.url ?? null;
      const threadPayload = {
        threadId: worker.threadId,
        title: worker.title,
        outcome: notice.outcome,
        projectId: worker.projectId,
        ...(worker.resultSummary ? { result: worker.resultSummary } : {}),
        ...(prUrl !== null ? { pr: prUrl } : {}),
      };
      // The finish row carries the tracked PR link plus the no-result note.
      const rowPhrase =
        prUrl !== null && notice.outcome === "completed"
          ? `${resultPhrase} — ${prUrl}`
          : resultPhrase;
      if (notice.kind === "stuck") {
        if (input.suppressRows === true) return;
        const needsYou = input.eventType === "worker.needs-you";
        yield* postWorkerMonitorRow({
          coordinatorThreadId: input.coordinatorThreadId,
          sourceKey: `stuck:${input.sourceEventId}`,
          tone: notice.tone,
          // The needs-you row is a Synara-native action card (retry / stop /
          // open thread) — NOT a fake provider user-input request.
          kind: needsYou ? "synara.worker.needs-you" : "synara.worker.stuck",
          summary: formatWorkerMonitorRow({
            title: worker.title,
            marker: notice.marker,
            phrase: resultPhrase,
          }),
          payload: {
            source: "worker_monitor",
            eventType: input.eventType,
            marker: notice.marker,
            phrase: resultPhrase,
            thread: threadPayload,
            ...(needsYou ? { actions: ["retry", "stop", "open"] } : {}),
          },
          createdAt: input.createdAt,
        });
        return;
      }
      const updated: ProjectManagedWorker = {
        ...worker,
        taskId: input.taskId ?? worker.taskId,
        settledAt: input.createdAt,
        settleOutcome: notice.outcome,
        waitingSince:
          notice.outcome === "waiting-approval" || notice.outcome === "waiting-input"
            ? (worker.waitingSince ?? input.createdAt)
            : null,
        // An event means the worker is alive; any stuck episode and recovery
        // ladder run is over, and a flagged "Waiting on you" resolves.
        // `recoveriesUsed` only resets on a genuine success — the ladder's own
        // re-dispatches keep the count so the cap can't loop forever.
        recoveriesUsed: notice.outcome === "completed" ? 0 : worker.recoveriesUsed,
        stuckKind: null,
        stuckSince: null,
        recoveryEpisode: null,
        recoveryStep: 0,
        nudgeAt: null,
        needsYou: false,
        needsYouAt: null,
        updatedAt: input.createdAt,
      };
      const saved = yield* repository
        .saveManagedWorkerMonitor({ worker: updated, expectedUpdatedAt: worker.updatedAt })
        .pipe(Effect.mapError(toServiceError("Failed to update managed worker.")));
      let persistedWorker = updated;
      if (!saved.applied) {
        // CAS miss: a concurrent write moved the row. Re-read once and apply
        // the settle facts on top — losing a settle is worse than retrying.
        const fresh = yield* repository
          .findManagedWorkerByThread(worker.threadId)
          .pipe(Effect.mapError(toServiceError("Failed to re-read managed worker.")));
        if (Option.isSome(fresh)) {
          persistedWorker = {
            ...updated,
            taskId: fresh.value.taskId ?? updated.taskId,
            recoveriesUsed: updated.recoveriesUsed,
            updatedAt: fresh.value.updatedAt,
          };
          yield* repository
            .saveManagedWorkerMonitor({
              worker: persistedWorker,
              expectedUpdatedAt: fresh.value.updatedAt,
            })
            .pipe(Effect.mapError(toServiceError("Failed to update managed worker.")));
        }
      }
      if (input.suppressRows !== true) {
        yield* postWorkerMonitorRow({
          coordinatorThreadId: input.coordinatorThreadId,
          sourceKey: `settle:${input.sourceEventId}`,
          tone: notice.tone,
          kind: "synara.worker.settled",
          summary: formatWorkerMonitorRow({
            title: worker.title,
            marker: notice.marker,
            phrase: rowPhrase,
          }),
          payload: {
            source: "worker_monitor",
            eventType: input.eventType,
            marker: notice.marker,
            phrase: rowPhrase,
            thread: threadPayload,
          },
          createdAt: input.createdAt,
        });
      }
      const batch = yield* repository
        .listManagedWorkersByBatch({ projectId: worker.projectId, batchId: worker.batchId })
        .pipe(Effect.mapError(toServiceError("Failed to load worker batch.")));
      // The just-written row is freshest; swap it into the batch listing in
      // case a concurrent ingest left the read behind.
      const peers = batch.map((row) => (row.threadId === worker.threadId ? persistedWorker : row));
      if (
        input.suppressRows !== true &&
        peers.length > 1 &&
        // Waiting on approval/input records a settle row but is not an end
        // state — the roll-up waits until every worker has really finished.
        peers.every(
          (row) => row.settledAt !== null && isTerminalWorkerSettleOutcome(row.settleOutcome),
        )
      ) {
        const signature = peers.map((row) => row.settleOutcome ?? "pending").join("|");
        const rollupKey = `${worker.batchId}:${signature}`;
        const rollupInserted = yield* repository
          .insertInboxEvent({
            id: branded.inbox(),
            projectId: worker.projectId,
            sourceThreadId: worker.threadId,
            sourceEventId: `worker-batch:${rollupKey}`,
            eventType: "workers.settled",
            taskId: input.taskId,
            eligibleWake: true,
            createdAt: input.createdAt,
          })
          .pipe(Effect.mapError(toServiceError("Failed to record worker batch roll-up.")));
        if (rollupInserted.inserted) {
          // Each finished worker's tracked PR belongs in the roll-up — the
          // current shell is already read; batch-fetch the peers' for theirs.
          const peerShells = yield* snapshotQuery
            .getThreadShellsByIds(peers.map((row) => row.threadId))
            .pipe(
              Effect.catch(() => Effect.succeed([] as ReadonlyArray<OrchestrationThreadShell>)),
            );
          const prByThread = new Map(
            peerShells.map((peer) => [peer.id, peer.lastKnownPr?.url ?? null]),
          );
          const threads = peers.map((row) => ({
            threadId: row.threadId,
            title: row.title,
            outcome: row.settleOutcome ?? "failed",
            result: row.resultSummary,
            pr: row.threadId === worker.threadId ? prUrl : (prByThread.get(row.threadId) ?? null),
          }));
          const allFinished = threads.every(
            (thread) => thread.outcome === "completed" || thread.outcome === "stopped",
          );
          yield* postWorkerMonitorRow({
            coordinatorThreadId: input.coordinatorThreadId,
            sourceKey: `rollup:${rollupKey}`,
            tone: allFinished ? "info" : "approval",
            kind: "synara.workers.settled",
            summary: formatWorkerBatchRollup({ threads }),
            payload: { source: "worker_monitor", batchId: worker.batchId, threads },
            createdAt: input.createdAt,
          });
        }
      }
    });

  // Stuck checks the health loop applies to every recorded managed worker:
  // missing shell (episode-keyed), failed session status, waiting on an
  // approval/user input past the waiting threshold, and running silent past
  // the quiet threshold. Terminal outcomes stop the waiting/silent checks.
  // The recovery ladder rides the silent check: each silent episode nudges the
  // worker once, then interrupts + re-dispatches its recorded task prompt once
  // the post-nudge delay elapses, bounded by WORKER_RECOVERY_MAX_ATTEMPTS per
  // episode chain. Exhaustion latches "Waiting on you" (needs-you dot + one
  // wake to tell the user). All ladder state lives on the durable worker row,
  // so a restart mid-episode resumes the same step.
  const inspectManagedWorkerHealth = (input: {
    readonly worker: ProjectManagedWorker;
    readonly shell: Option.Option<OrchestrationThreadShell>;
    /** Thread ids with a live provider session (connecting/ready/running).
     * null when the live listing failed — the disconnect check is skipped. */
    readonly liveWorkerThreadIds: ReadonlySet<string> | null;
  }) =>
    Effect.gen(function* () {
      const worker = input.worker;
      const nowMs = yield* Clock.currentTimeMillis;
      const nowIso = new Date(nowMs).toISOString();
      const serviceError = toServiceError("Failed to update managed worker health state.");
      // CAS stamp of the freshest known row — every successful write advances
      // it so claims later in the same tick CAS against the latest revision.
      let rowStamp = worker.updatedAt;
      // All health-loop writes go through here: CAS on `rowStamp`, and on a
      // miss re-read once and merge only the ladder-owned fields on top of the
      // winning row — a concurrent settle or the dispatch-triggered
      // recordWorkerTurnRequest write must neither drop the ladder's claim
      // nor be clobbered by it.
      const persistWorkerUpdate = (next: ProjectManagedWorker) =>
        Effect.gen(function* () {
          const claimed = yield* repository
            .saveManagedWorkerMonitor({ worker: next, expectedUpdatedAt: rowStamp })
            .pipe(Effect.mapError(serviceError));
          if (claimed.applied) {
            rowStamp = next.updatedAt;
            return true;
          }
          const fresh = yield* repository
            .findManagedWorkerByThread(worker.threadId)
            .pipe(Effect.mapError(serviceError));
          if (Option.isNone(fresh)) return false;
          const merged: ProjectManagedWorker = {
            ...fresh.value,
            stuckKind: next.stuckKind,
            stuckSince: next.stuckSince,
            waitingSince: next.waitingSince,
            recoveryEpisode: next.recoveryEpisode,
            recoveryStep: next.recoveryStep,
            nudgeAt: next.nudgeAt,
            recoveriesUsed: next.recoveriesUsed,
            needsYou: next.needsYou,
            needsYouAt: next.needsYouAt,
            updatedAt: next.updatedAt,
          };
          const retried = yield* repository
            .saveManagedWorkerMonitor({
              worker: merged,
              expectedUpdatedAt: fresh.value.updatedAt,
            })
            .pipe(Effect.mapError(serviceError));
          if (retried.applied) {
            rowStamp = merged.updatedAt;
            return true;
          }
          return false;
        });
      let updated = worker;
      // Claim a ladder step BEFORE dispatching its command: the row write
      // lands first so the async recordWorkerTurnRequest rewrite can't drop
      // recoveriesUsed / recoveryStep when it lands between the dispatch and
      // the save. A failed dispatch rolls the claim back so a transient
      // engine error doesn't burn an attempt.
      const claimLadderStep = (
        patch: Partial<ProjectManagedWorker>,
        dispatch: Effect.Effect<boolean, ProjectAgentServiceError>,
      ) =>
        Effect.gen(function* () {
          const claimed: ProjectManagedWorker = { ...updated, ...patch, updatedAt: nowIso };
          const previous = updated;
          if (!(yield* persistWorkerUpdate(claimed))) return false;
          const dispatched = yield* dispatch;
          if (!dispatched) {
            yield* persistWorkerUpdate(previous);
            return false;
          }
          updated = claimed;
          return true;
        });
      const ingestHealthEvent = (sourceEventId: string, eventType: string) =>
        impl
          .ingestSettledThreadEvent({
            threadId: worker.threadId,
            sourceEventId,
            eventType,
            createdAt: nowIso,
          })
          .pipe(
            Effect.catch((error) =>
              appendActivity({
                projectId: worker.projectId,
                kind: "error",
                actorKind: "system",
                actorThreadId: worker.threadId,
                goalId: null,
                taskId: null,
                source: null,
                summary: `Worker monitor ingest ${eventType} on ${worker.threadId}: ${String(error)}`,
                createdAt: nowIso,
              }),
            ),
          );

      // Recovery dispatches reuse the same orchestration commands the
      // coordinator tools send (steer message, interrupt, queued turn). Their
      // deterministic command ids carry the WORKER_RECOVERY_COMMAND_PREFIX so
      // the settle reactor ignores the interrupt side effects, and a crash
      // between dispatch and the row write replays the same ids.
      const dispatchRecovery = (command: OrchestrationCommand) =>
        orchestrationEngine.dispatch(command).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            appendActivity({
              projectId: worker.projectId,
              kind: "error",
              actorKind: "system",
              actorThreadId: worker.threadId,
              goalId: null,
              taskId: null,
              source: null,
              summary: `Worker recovery dispatch ${command.type} on ${worker.threadId}: ${String(error)}`,
              createdAt: nowIso,
            }).pipe(Effect.as(false)),
          ),
        );

      // A terminal settle already reported: monitoring ends there, so the
      // health checks below (missing shell, failed status, overdue waiting,
      // silent running + recovery) must not post another episode.
      if (isTerminalWorkerSettleOutcome(worker.settleOutcome)) return;
      if (Option.isNone(input.shell)) {
        // Missing shell: one episode, keyed by its first-seen timestamp. A
        // worker already settled as missing stays quiet while the shell is
        // still gone — a later settle event re-opens reporting.
        if (worker.stuckKind === "missing") return;
        const stuckSince = nowIso;
        if (
          yield* persistWorkerUpdate({
            ...worker,
            stuckKind: "missing",
            stuckSince,
            updatedAt: nowIso,
          })
        ) {
          yield* ingestHealthEvent(
            `worker-health:${worker.threadId}:missing:${stuckSince}`,
            "worker.missing",
          );
        }
        return;
      }
      const shell = input.shell.value;
      const sessionStatus = shell.session?.status ?? null;
      if (isFailedWorkerSessionStatus(sessionStatus)) {
        const updatedAt = shell.session?.updatedAt ?? shell.updatedAt;
        yield* ingestHealthEvent(
          `worker-health:${worker.threadId}:${sessionStatus}:${updatedAt}`,
          `worker.${sessionStatus}`,
        );
        return;
      }

      // Silence is measured from the thread's last runtime activity of ANY
      // kind — ingestion maintains `lastActivityAt` on the projected session;
      // `updatedAt` (lifecycle only) and the shell stamp stay as fallbacks.
      const lastActivity =
        shell.session?.lastActivityAt ?? shell.session?.updatedAt ?? shell.updatedAt;

      // Immediate liveness: the projection says running but no live provider
      // session owns the thread — the process died or disconnected while its
      // status stayed "running". The grace covers adapter-listing lag on a
      // fresh spawn.
      if (
        sessionStatus === "running" &&
        input.liveWorkerThreadIds !== null &&
        !input.liveWorkerThreadIds.has(worker.threadId) &&
        nowMs - Date.parse(shell.session?.updatedAt ?? lastActivity) > WORKER_DISCONNECT_GRACE_MS
      ) {
        yield* ingestHealthEvent(
          `worker-health:${worker.threadId}:disconnected:${shell.session?.updatedAt ?? lastActivity}`,
          "worker.disconnected",
        );
        return;
      }

      if (worker.stuckKind === "missing") {
        updated = { ...updated, stuckKind: null, stuckSince: null };
      }
      const terminal =
        worker.settleOutcome === "completed" ||
        worker.settleOutcome === "stopped" ||
        worker.settleOutcome === "failed" ||
        worker.settleOutcome === "interrupted" ||
        worker.settleOutcome === "missing";

      // "Waiting on you": the latch is the same for every path that reaches
      // it — flag + Synara-native row with retry/stop actions (posted by the
      // `worker.needs-you` ingest), never a fake provider request.
      const latchNeedsYou = (dedupeKey: string) =>
        Effect.gen(function* () {
          if (updated.needsYou) return;
          const claimed: ProjectManagedWorker = {
            ...updated,
            needsYou: true,
            needsYouAt: nowIso,
            updatedAt: nowIso,
          };
          if (yield* persistWorkerUpdate(claimed)) {
            updated = claimed;
            yield* ingestHealthEvent(
              `worker-health:${worker.threadId}:needs-you:${dedupeKey}`,
              "worker.needs-you",
            );
          }
        });
      const redispatchCommand = (step: string) => {
        const prompt = worker.taskPrompt;
        if (prompt === null || prompt.trim().length === 0) return null;
        const commandId = `${WORKER_RECOVERY_COMMAND_PREFIX}${worker.threadId}:${lastActivity}:${step}`;
        return {
          type: "thread.turn.start" as const,
          commandId: CommandId.makeUnsafe(commandId),
          threadId: worker.threadId,
          message: {
            messageId: MessageId.makeUnsafe(`${commandId}:message`),
            role: "user" as const,
            text: prompt,
            attachments: [] as Array<never>,
          },
          dispatchMode: "queue" as const,
          dispatchOrigin: "automation" as const,
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          createdAt: nowIso,
        };
      };
      const nudgeCommand = (step: string) => {
        const commandId = `${WORKER_RECOVERY_COMMAND_PREFIX}${worker.threadId}:${lastActivity}:${step}`;
        return {
          type: "thread.turn.start" as const,
          commandId: CommandId.makeUnsafe(commandId),
          threadId: worker.threadId,
          message: {
            messageId: MessageId.makeUnsafe(`${commandId}:message`),
            role: "user" as const,
            text: WORKER_RECOVERY_NUDGE_TEXT,
            attachments: [] as Array<never>,
          },
          dispatchMode: "steer" as const,
          dispatchOrigin: "automation" as const,
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          createdAt: nowIso,
        };
      };

      // Never started: the coordinator created the worker but no session or
      // first turn landed within the grace window — one counted re-dispatch,
      // then "Waiting on you" under the same recovery cap.
      const turnStarted =
        shell.session?.activeTurnId != null || shell.latestTurn?.startedAt != null;
      if (!turnStarted && nowMs - Date.parse(worker.createdAt) > WORKER_NEVER_STARTED_MS) {
        if (updated.stuckKind !== "never-started") {
          const claimed: ProjectManagedWorker = {
            ...updated,
            stuckKind: "never-started",
            stuckSince: worker.createdAt,
            updatedAt: nowIso,
          };
          if (yield* persistWorkerUpdate(claimed)) {
            updated = claimed;
            yield* ingestHealthEvent(
              `worker-health:${worker.threadId}:never-started:${worker.createdAt}`,
              "worker.never-started",
            );
          }
        }
        if (updated.recoveriesUsed >= WORKER_RECOVERY_MAX_ATTEMPTS) {
          yield* latchNeedsYou(`never-started:${worker.createdAt}`);
        } else if (
          updated.nudgeAt === null ||
          nowMs - Date.parse(updated.nudgeAt) > WORKER_RECOVERY_REDELIVER_DELAY_MS
        ) {
          const command = redispatchCommand("never-started-redispatch");
          if (command === null) {
            yield* latchNeedsYou(`never-started:${worker.createdAt}`);
          } else {
            const claimed = yield* claimLadderStep(
              {
                recoveriesUsed: updated.recoveriesUsed + 1,
                nudgeAt: nowIso,
              },
              dispatchRecovery(command),
            );
            if (claimed) {
              yield* ingestHealthEvent(
                `worker-health:${worker.threadId}:never-started-redispatched:${worker.createdAt}`,
                "worker.recovery-redispatched",
              );
            }
          }
        }
      } else if (!terminal && !updated.needsYou) {
        if (updated.stuckKind === "never-started") {
          updated = { ...updated, stuckKind: null, stuckSince: null };
        }
        const waiting = shell.hasPendingApprovals || shell.hasPendingUserInput;
        if (waiting) {
          const waitingSince = updated.waitingSince ?? nowIso;
          updated = { ...updated, waitingSince };
          if (
            nowMs - Date.parse(waitingSince) > WORKER_STUCK_WAITING_MS &&
            updated.stuckKind !== "waiting"
          ) {
            const claimed: ProjectManagedWorker = {
              ...updated,
              stuckKind: "waiting",
              stuckSince: waitingSince,
              updatedAt: nowIso,
            };
            if (yield* persistWorkerUpdate(claimed)) {
              updated = claimed;
              yield* ingestHealthEvent(
                `worker-health:${worker.threadId}:waiting:${waitingSince}`,
                "worker.waiting-overdue",
              );
            }
          }
        } else {
          if (updated.waitingSince !== null) updated = { ...updated, waitingSince: null };
          if (updated.stuckKind === "waiting") {
            updated = { ...updated, stuckKind: null, stuckSince: null };
          }
          const toolRows = yield* projectionThreadSessionRepository
            .getToolInFlight({ threadId: worker.threadId })
            .pipe(Effect.catch(() => Effect.succeed([])));
          const toolInFlight = toolRows.length > 0;
          const oldestTool = toolRows[0];
          const quietForMs = nowMs - Date.parse(lastActivity);
          const userTurn = updated.activeTurnOrigin === "user";
          // "Real progress" is what unsticks a worker: agent output, tool
          // lifecycle, or a new turn AFTER the ladder's last action (the
          // nudge's own echo back is activity without progress). Only
          // progress clears the ladder — anything less just re-anchors the
          // quiet window while the chain keeps its position.
          const lastProgress = shell.session?.lastProgressAt ?? null;
          const progressAnchor = updated.nudgeAt ?? updated.stuckSince;
          const madeProgress =
            lastProgress !== null && progressAnchor !== null && lastProgress > progressAnchor;
          if (toolInFlight && oldestTool !== undefined) {
            if (updated.stuckKind === "silent") {
              // A tool started mid-episode — the silence was queued work, not
              // a stall; clear the ladder state.
              const claimed: ProjectManagedWorker = {
                ...updated,
                stuckKind: null,
                stuckSince: null,
                recoveryEpisode: null,
                recoveryStep: 0,
                nudgeAt: null,
                updatedAt: nowIso,
              };
              if (yield* persistWorkerUpdate(claimed)) updated = claimed;
            }
            // Past the hard cap the ladder only nudges + notifies — a running
            // tool is never interrupted.
            if (!userTurn && nowMs - Date.parse(oldestTool.startedAt) > WORKER_TOOL_OVERTIME_MS) {
              if (updated.stuckKind !== "tool-overtime") {
                const claimed: ProjectManagedWorker = {
                  ...updated,
                  stuckKind: "tool-overtime",
                  stuckSince: oldestTool.startedAt,
                  updatedAt: nowIso,
                };
                if (yield* persistWorkerUpdate(claimed)) updated = claimed;
              }
              yield* ingestHealthEvent(
                `worker-health:${worker.threadId}:tool-overtime:${oldestTool.startedAt}`,
                "worker.tool-overtime",
              );
              if (updated.nudgeAt !== oldestTool.startedAt) {
                yield* claimLadderStep(
                  { nudgeAt: oldestTool.startedAt },
                  dispatchRecovery(nudgeCommand("tool-overtime-nudge")),
                );
              }
            }
          } else if (!userTurn) {
            // Turn-ownership gate: the ladder only acts on turns it or the
            // coordinator started — a user-owned turn is never steered,
            // interrupted, or re-prompted. null (pre-feature workers) stays
            // monitored like "coordinator".
            if (sessionStatus === "running" && quietForMs > WORKER_STUCK_RUNNING_QUIET_MS) {
              if (updated.stuckKind === "silent" && !madeProgress) {
                // Activity arrived but produced no work (e.g. the nudge
                // echoing back) — re-anchor the quiet window to the newest
                // stamp WITHOUT resetting the ladder's position, so the same
                // chain keeps escalating instead of restarting each echo.
                if (
                  updated.stuckSince !== lastActivity ||
                  updated.recoveryEpisode !== lastActivity
                ) {
                  const claimed: ProjectManagedWorker = {
                    ...updated,
                    stuckSince: lastActivity,
                    recoveryEpisode: lastActivity,
                    updatedAt: nowIso,
                  };
                  if (yield* persistWorkerUpdate(claimed)) updated = claimed;
                }
              } else {
                if (updated.stuckKind === "silent") {
                  // Real progress landed since the ladder's last action — the
                  // chain is over. A fresh episode still keys below if the
                  // quiet window has since elapsed again.
                  const claimed: ProjectManagedWorker = {
                    ...updated,
                    stuckKind: null,
                    stuckSince: null,
                    recoveryEpisode: null,
                    recoveryStep: 0,
                    nudgeAt: null,
                    updatedAt: nowIso,
                  };
                  if (yield* persistWorkerUpdate(claimed)) updated = claimed;
                }
                if (updated.stuckKind !== "silent") {
                  // A fresh silent episode keys the chain on the quiet-window
                  // stamp — the lifetime recovery count survives so the cap
                  // still bounds the loop.
                  const claimed: ProjectManagedWorker = {
                    ...updated,
                    stuckKind: "silent",
                    stuckSince: lastActivity,
                    recoveryEpisode: lastActivity,
                    recoveryStep: 0,
                    nudgeAt: null,
                    updatedAt: nowIso,
                  };
                  if (yield* persistWorkerUpdate(claimed)) {
                    updated = claimed;
                    yield* ingestHealthEvent(
                      `worker-health:${worker.threadId}:silent:${lastActivity}`,
                      "worker.silent",
                    );
                  }
                }
              }
              if (updated.recoveryEpisode === lastActivity) {
                if (updated.recoveryStep === 0) {
                  if (updated.recoveriesUsed >= WORKER_RECOVERY_MAX_ATTEMPTS) {
                    yield* latchNeedsYou(`silent:${lastActivity}`);
                  } else {
                    // Step 1 — nudge through the same steer path the
                    // coordinator's send tool uses. The nudge itself counts
                    // against the cap so a provider that merely echoes it
                    // can't loop forever.
                    const claimed = yield* claimLadderStep(
                      {
                        recoveryStep: 1,
                        nudgeAt: nowIso,
                        recoveriesUsed: updated.recoveriesUsed + 1,
                      },
                      dispatchRecovery(nudgeCommand("nudge")),
                    );
                    if (claimed) {
                      yield* ingestHealthEvent(
                        `worker-health:${worker.threadId}:nudged:${lastActivity}`,
                        "worker.nudged",
                      );
                    }
                  }
                } else if (
                  updated.recoveryStep === 1 &&
                  updated.nudgeAt !== null &&
                  nowMs - Date.parse(updated.nudgeAt) > WORKER_RECOVERY_REDELIVER_DELAY_MS
                ) {
                  // Step 2 — still quiet after the nudge: interrupt the
                  // stalled turn, then re-dispatch the recorded task prompt
                  // once. The step's claim persists before either dispatch.
                  if (updated.recoveriesUsed >= WORKER_RECOVERY_MAX_ATTEMPTS) {
                    yield* latchNeedsYou(`silent:${lastActivity}`);
                  } else {
                    const command = redispatchCommand("redispatch");
                    if (command === null) {
                      yield* latchNeedsYou(`silent:${lastActivity}`);
                    } else {
                      const turnActive =
                        shell.session?.activeTurnId != null ||
                        shell.latestTurn?.state === "running";
                      const interruptCommandId = `${WORKER_RECOVERY_COMMAND_PREFIX}${worker.threadId}:${lastActivity}:interrupt`;
                      const dispatchStep = Effect.gen(function* () {
                        const interrupted = turnActive
                          ? yield* dispatchRecovery({
                              type: "thread.turn.interrupt",
                              commandId: CommandId.makeUnsafe(interruptCommandId),
                              threadId: worker.threadId,
                              createdAt: nowIso,
                            })
                          : true;
                        if (!interrupted) return false;
                        return yield* dispatchRecovery(command);
                      });
                      const claimed = yield* claimLadderStep(
                        {
                          recoveryStep: 2,
                          nudgeAt: nowIso,
                          recoveriesUsed: updated.recoveriesUsed + 1,
                        },
                        dispatchStep,
                      );
                      if (claimed) {
                        yield* ingestHealthEvent(
                          `worker-health:${worker.threadId}:redispatched:${lastActivity}`,
                          "worker.recovery-redispatched",
                        );
                      }
                    }
                  }
                } else if (
                  updated.recoveryStep === 2 &&
                  updated.nudgeAt !== null &&
                  nowMs - Date.parse(updated.nudgeAt) > WORKER_STUCK_RUNNING_QUIET_MS
                ) {
                  // The re-dispatch produced no events within a full quiet
                  // window — that stall counts as another episode of the same
                  // chain and either starts a new cycle or, at the cap, flags
                  // the worker "Waiting on you".
                  const claimed: ProjectManagedWorker = {
                    ...updated,
                    recoveryStep: 0,
                    updatedAt: nowIso,
                  };
                  if (yield* persistWorkerUpdate(claimed)) updated = claimed;
                  if (updated.recoveriesUsed >= WORKER_RECOVERY_MAX_ATTEMPTS) {
                    yield* latchNeedsYou(`silent:${lastActivity}`);
                  }
                }
              }
            } else if (
              (updated.stuckKind === "silent" || updated.stuckKind === "tool-overtime") &&
              madeProgress
            ) {
              // Fresh activity only ends the episode when it produced real
              // work — a nudge echo must not clear the ladder it was meant to
              // unstick (that path re-anchors above instead).
              const claimed: ProjectManagedWorker = {
                ...updated,
                stuckKind: null,
                stuckSince: null,
                recoveryEpisode: null,
                recoveryStep: 0,
                nudgeAt: null,
                updatedAt: nowIso,
              };
              if (yield* persistWorkerUpdate(claimed)) updated = claimed;
            }
          }
        }
      }
      if (updated !== worker) {
        yield* persistWorkerUpdate({ ...updated, updatedAt: nowIso });
      }
    });

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
      const upserted: ProjectThreadIndexEntry[] = [];
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
        upserted.push(next);
      }
      yield* publishThreadIndexUpserts(projectId, upserted);
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
      const linkedProjectIds = yield* repository
        .listLinkedProjectIds(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load linked projects.")));
      if (Option.isNone(config)) {
        return {
          projectId,
          configured: false,
          config: null,
          linkedProjectIds,
          goal: null,
          digest: null,
          blockers: [],
          recentOutcomes: [],
          workers: [],
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
      // Managed workers go out with the overview so the web can show
      // "Waiting on you" badges and per-worker state without a second call.
      const workers = yield* repository
        .listManagedWorkers(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load managed workers.")));
      const blockers = tasks
        .filter((task) => task.status === "blocked")
        .map((task) => ({
          taskId: task.id,
          title: task.title,
          reason: task.acceptanceCriteria ?? "Blocked",
        }));
      const goalValue = Option.getOrNull(goal);
      // The coordinator row must reflect the live thread session (same source
      // the sidebar uses), not just the goal lifecycle — a coordinator whose
      // turn is in flight is "running" even when no goal is active.
      const coordinatorShell = yield* snapshotQuery
        .getThreadShellById(config.value.coordinatorThreadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
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
        linkedProjectIds,
        goal: goalValue,
        digest: digestValue,
        blockers,
        recentOutcomes: activity,
        workers,
        coordinatorStatus: coordinatorStatusFromGoal(
          true,
          goalValue?.status ?? null,
          Option.getOrNull(coordinatorShell),
        ),
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

  interface WakeReceiptResult {
    readonly runId?: string;
    readonly claimedAt?: string;
  }

  const readWakeReceipt = (projectId: ProjectId, requestId: string) =>
    repository.getReceipt({ requestId, projectId }).pipe(
      Effect.mapError(toServiceError("Failed to load wake receipt.")),
      Effect.map((option) =>
        Option.isSome(option) ? (JSON.parse(option.value.resultJson) as WakeReceiptResult) : null,
      ),
    );

  // Dispatches the coordinator continuation for an inbox range exactly once.
  // Receipts are insert-only, so the range's claim lives on a sibling id:
  // `${receiptId}:claim` is written BEFORE runNow, meaning a crash between run
  // start and receipt save can never enqueue a second run. On re-drive a young
  // claim resolves the run it launched from the automation history; an expired
  // one means the earlier dispatch threw and the range is re-dispatched.
  const dispatchWakeContinuation = (input: {
    readonly projectId: ProjectId;
    readonly receiptId: string;
    readonly automationId: AutomationId;
    readonly existingWake: WakeReceiptResult | null;
  }) =>
    Effect.gen(function* () {
      if (input.existingWake?.runId) {
        return { runId: input.existingWake.runId, dispatched: false as const };
      }
      const claimId = wakeClaimRequestId(input.receiptId);
      const claim = yield* repository
        .getReceipt({ requestId: claimId, projectId: input.projectId })
        .pipe(Effect.mapError(toServiceError("Failed to load wake claim.")));
      if (Option.isSome(claim)) {
        const claimAge = Date.now() - Date.parse(claim.value.createdAt);
        if (claimAge < WAKE_CLAIM_TTL_MS) {
          // The earlier dispatch claimed this range — adopt the run it
          // launched rather than queueing a duplicate continuation.
          const runs = yield* automationService
            .listRunsForDefinition({ automationId: input.automationId, limit: 1 })
            .pipe(Effect.mapError(toServiceError("Failed to list coordinator runs.")));
          const runId = runs[0]?.id;
          if (runId === undefined) {
            // The claimed run is not visible yet; leave the range for the
            // next wake rather than racing a second dispatch.
            return { runId: null, dispatched: false as const };
          }
          yield* storeReceipt(input.receiptId, input.projectId, "wake", { runId });
          return { runId, dispatched: false as const };
        }
      }
      yield* storeReceipt(claimId, input.projectId, "wake-claim", {
        claimedAt: isoNow(),
      });
      const run = yield* automationService
        .runNow({ automationId: input.automationId })
        .pipe(Effect.mapError(toServiceError("Failed to dispatch coordinator continuation.")));
      const runId = run.run.id;
      yield* storeReceipt(input.receiptId, input.projectId, "wake", { runId });
      return { runId, dispatched: true as const };
    });

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

  // ===== Groups: memory, library, threads, and lifecycle helpers =====

  // The library root is the group's writable artifact store. Resolution
  // mirrors the WS `resolveGroupLibrary` gate: the (optional) config supplies
  // libraryPath, and the root is re-validated against workspace/state roots.
  const resolveGroupLibraryRoot = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const agentConfig = yield* repository
        .getConfig(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load project coordinator.")))
        .pipe(Effect.map(Option.getOrNull));
      const root = yield* resolveLibraryRoot({
        stateDir: serverConfig.stateDir,
        projectId,
        libraryPath: agentConfig?.libraryPath,
      }).pipe(Effect.mapError(toServiceError("Failed to resolve the group library.")));
      yield* assertLibraryRootLocation({
        root,
        stateDir: serverConfig.stateDir,
        groupsWorkspaceRoot: serverConfig.groupsWorkspaceRoot,
        studioWorkspaceRoot: serverConfig.studioWorkspaceRoot,
        isCustomPath: agentConfig?.libraryPath !== undefined,
        projectId,
      }).pipe(Effect.mapError(toServiceError("Failed to resolve the group library.")));
      return {
        root,
        agentConfig,
        libraryIsManaged: agentConfig?.libraryPath === undefined,
      };
    });

  const pushLibraryInBackground = (
    root: string,
    agentConfig: {
      readonly libraryRemoteUrl?: string | undefined;
      readonly libraryPushOnChange?: boolean | undefined;
    } | null,
  ) =>
    Effect.forkDetach(
      withLibraryQueue(
        root,
        pushLibraryIfConfigured({
          git,
          root,
          libraryRemoteUrl: agentConfig?.libraryRemoteUrl,
          libraryPushOnChange: agentConfig?.libraryPushOnChange,
        }),
      ),
    );

  const readGroupMemoryNoteRevisions = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const heads = yield* repository
        .listDocumentHeads(projectId)
        .pipe(Effect.mapError(toServiceError("Failed to list group memory.")));
      const paths = heads
        .map((head) => head.logicalPath)
        .filter((logicalPath) => GROUP_MEMORY_NOTE_PATTERN.test(logicalPath));
      if (paths.length === 0) {
        return [] as ReadonlyArray<ProjectDocumentRevision>;
      }
      return yield* repository
        .readDocumentRevisions({ projectId, logicalPaths: paths })
        .pipe(Effect.mapError(toServiceError("Failed to read group memory.")));
    });

  // One `- [title](path) — summary` line per note in MEMORY.md, the index
  // every group thread reads. Rewritten through upsertSystemDocument so it
  // keeps its system authorship and disk mirror.
  const updateMemoryIndex = (input: {
    readonly projectId: ProjectId;
    readonly logicalPath: string;
    readonly title: string;
    readonly summary: string | null;
  }) =>
    Effect.gen(function* () {
      const current = yield* repository
        .readDocumentRevision({
          projectId: input.projectId,
          logicalPath: MEMORY_AUTO_DOCUMENT_PATH,
        })
        .pipe(Effect.mapError(toServiceError("Failed to load the memory index.")));
      const content = Option.isSome(current) ? current.value.content : "# Memory\n";
      const lines = content.split("\n");
      // Match index lines by their exact link target — substring includes()
      // would let one note's path hit inside another's longer path or a
      // title carrying forged `](...)` text. Entries are `- [t](path) — s`,
      // so the target must close the link segment before the summary dash.
      const lineTargetsPath = (line: string) => {
        if (!line.startsWith("- [")) return false;
        const linkSegment = line.split(" — ", 1)[0] ?? line;
        return linkSegment.endsWith(`](${input.logicalPath})`);
      };
      const index = lines.findIndex(lineTargetsPath);
      if (input.summary === null) {
        if (index < 0) return;
        lines.splice(index, 1);
      } else {
        const entry = `- [${input.title}](${input.logicalPath}) — ${input.summary}`;
        if (index >= 0) lines[index] = entry;
        else lines.push(entry);
        // Cap the index: drop the oldest entries first, never the one just
        // written.
        const entryCount = () => lines.filter((line) => line.startsWith("- [")).length;
        while (entryCount() > MEMORY_INDEX_MAX_ENTRIES) {
          const oldest = lines.findIndex(
            (line) => line.startsWith("- [") && !lineTargetsPath(line),
          );
          if (oldest < 0) break;
          lines.splice(oldest, 1);
        }
      }
      const next = lines.join("\n").replace(/\n{3,}/g, "\n\n");
      yield* upsertSystemDocument({
        projectId: input.projectId,
        logicalPath: MEMORY_AUTO_DOCUMENT_PATH,
        content: next.endsWith("\n") ? next : `${next}\n`,
      });
    });

  // A library_add source must live inside the calling thread's own workspace
  // (its worktree when one is materialized, otherwise its project cwd) — the
  // same containment rule the upload route applies to its own root. Nested
  // symlinks are never dereferenced on copy; a top-level link that resolves
  // outside the workspace is rejected by the realpath pair.
  const resolveLibraryCallerSource = (principal: ProjectAgentPrincipal, sourcePath: string) =>
    Effect.gen(function* () {
      if (principal.kind === "user") {
        return yield* Effect.fail(
          fail("The library add tool runs from a group thread or the coordinator.", "forbidden"),
        );
      }
      const shell = yield* snapshotQuery
        .getThreadShellById(principal.threadId)
        .pipe(Effect.mapError(toServiceError("Failed to load calling thread.")));
      if (Option.isNone(shell)) {
        return yield* Effect.fail(fail("Calling thread was not found.", "not-found"));
      }
      const project = yield* snapshotQuery
        .getProjectShellById(shell.value.projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load calling project.")));
      const workspaceRoot = resolveThreadWorkspaceCwd({
        projectCwd: Option.isSome(project) ? project.value.workspaceRoot : null,
        envMode: shell.value.envMode,
        worktreePath: shell.value.worktreePath,
        workingDirectory: shell.value.workingDirectory,
      });
      if (workspaceRoot === null) {
        return yield* Effect.fail(fail("The calling thread has no workspace yet.", "invalid"));
      }
      const candidate = path.isAbsolute(sourcePath)
        ? path.normalize(sourcePath)
        : path.resolve(workspaceRoot, sourcePath);
      const resolved = yield* Effect.tryPromise({
        try: async () => {
          const [realRoot, realTarget] = await Promise.all([
            fs.realpath(workspaceRoot),
            fs.realpath(candidate),
          ]);
          return { realRoot, realTarget };
        },
        catch: () =>
          fail(`Library source "${sourcePath}" was not found in the workspace.`, "not-found"),
      });
      if (!isContainedPath(resolved.realRoot, resolved.realTarget)) {
        return yield* Effect.fail(
          fail(
            `Library source "${sourcePath}" must stay inside the calling thread's workspace.`,
            "forbidden",
          ),
        );
      }
      const relative = path.relative(resolved.realRoot, resolved.realTarget);
      if (relative === "") {
        return yield* Effect.fail(
          fail("Choose a file or folder inside the workspace, not the workspace root.", "invalid"),
        );
      }
      if (relative.split(path.sep).some((segment) => segment.toLowerCase() === ".git")) {
        return yield* Effect.fail(
          fail(`Library source "${sourcePath}" cannot address repository metadata.`, "forbidden"),
        );
      }
      return { source: resolved.realTarget, threadTitle: shell.value.title };
    });

  // Group membership for threads = the group's own threads plus anything the
  // thread index or task assignments recorded (linked-repo workers live
  // outside the group project but still belong to it).
  const listGroupThreadShells = (input: {
    readonly projectId: ProjectId;
    readonly coordinatorThreadId: ThreadId | null;
  }) =>
    Effect.gen(function* () {
      const index = yield* repository
        .listThreadIndex(input.projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load group threads.")));
      const groupThreads = yield* projectionThreads
        .listByProjectId({ projectId: input.projectId })
        .pipe(Effect.mapError(toServiceError("Failed to load group threads.")));
      const tasks = yield* repository
        .listTasks({ projectId: input.projectId, includeArchived: true, limit: 500 })
        .pipe(Effect.mapError(toServiceError("Failed to load group tasks.")));
      const workers = yield* repository
        .listManagedWorkers(input.projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load managed workers.")));
      const ids = new Set<ThreadId>();
      for (const thread of groupThreads) {
        if (thread.deletedAt === null && thread.threadId !== input.coordinatorThreadId) {
          ids.add(thread.threadId);
        }
      }
      for (const entry of index) {
        if (entry.threadId !== input.coordinatorThreadId) ids.add(entry.threadId);
      }
      for (const task of tasks) {
        if (task.assignedThreadId && task.assignedThreadId !== input.coordinatorThreadId) {
          ids.add(task.assignedThreadId);
        }
      }
      for (const worker of workers) {
        if (worker.threadId !== input.coordinatorThreadId) ids.add(worker.threadId);
      }
      const shells = yield* snapshotQuery
        .getThreadShellsByIds([...ids])
        .pipe(Effect.mapError(toServiceError("Failed to load group threads.")));
      return { index, tasks, shells };
    });

  const dispatchGroupThreadCommand = (
    threadIds: ReadonlyArray<ThreadId>,
    type: "thread.turn.interrupt" | "thread.archive" | "thread.unarchive" | "thread.delete",
    options?: { readonly stopOnError?: boolean },
  ) =>
    Effect.forEach(
      threadIds,
      (threadId) => {
        const dispatch = orchestrationEngine.dispatch({
          type,
          commandId: branded.command(),
          threadId,
          createdAt: isoNow(),
        } as OrchestrationCommand);
        return options?.stopOnError === true
          ? dispatch.pipe(Effect.mapError(toServiceError("Failed to update group threads.")))
          : dispatch.pipe(Effect.catch(() => Effect.void));
      },
      { discard: true },
    );

  // Pause/archive disable the group's automations and record exactly which
  // were on, so resume/unarchive restore only what the lifecycle turned off.
  const disableGroupAutomations = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const listed = yield* automationService
        .list({ projectId })
        .pipe(Effect.mapError(toServiceError("Failed to load group automations.")));
      const enabledIds = listed.definitions
        .filter((definition) => definition.enabled && definition.archivedAt === null)
        .map((definition) => definition.id);
      for (const id of enabledIds) {
        yield* automationService
          .update({ id, enabled: false })
          .pipe(Effect.catch(() => Effect.void));
      }
      return enabledIds;
    });

  const restoreGroupAutomations = (automationIds: ReadonlyArray<AutomationId>) =>
    Effect.forEach(
      automationIds,
      (id) => automationService.update({ id, enabled: true }).pipe(Effect.catch(() => Effect.void)),
      { discard: true },
    );

  const libraryPathExists = (target: string) =>
    Effect.tryPromise({
      try: async () => {
        await fs.access(target);
        return true;
      },
      catch: () => "unreachable",
    }).pipe(Effect.catch(() => Effect.succeed(false)));

  // Deleting a group moves its library to the OS trash (rename inside the
  // trash dir) — never an rm -rf, and never of a custom libraryPath at all:
  // a user-chosen library folder is left exactly where the user put it.
  const moveLibraryToTrash = (root: string) =>
    Effect.tryPromise({
      try: async () => {
        const platform = os.platform();
        const home = os.homedir();
        const trashDir =
          serverConfig.trashDir ??
          (platform === "darwin"
            ? path.join(home, ".Trash")
            : platform === "win32"
              ? null
              : path.join(home, ".local", "share", "Trash", "files"));
        if (trashDir === null) return false;
        await fs.mkdir(trashDir, { recursive: true });
        const target = path.join(trashDir, `${path.basename(root)}-${randomUUID().slice(0, 8)}`);
        await fs.rename(root, target);
        return true;
      },
      catch: () => "unreachable",
    }).pipe(Effect.catch(() => Effect.succeed(false)));

  const requireUserLifecycleAction = (action: string, principal: ProjectAgentPrincipal) =>
    isUserPrincipal(principal)
      ? Effect.void
      : Effect.fail(fail(`${action} is a user action.`, "forbidden"));

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
      // wake-skipped rows are wake bookkeeping, not group activity — feeding
      // them into the digest input would churn the signature (and the prompt)
      // with noise that never belongs in a project summary.
      const digestActivity = activity.filter((entry) => entry.kind !== "wake-skipped");
      const inputSignature = hashDocumentContent(
        JSON.stringify([
          digestActivity.map((entry) => [entry.id, entry.sequence]),
          tasks.map((task) => [task.id, task.revision, task.status, task.archivedAt]),
          documents.map((doc) => [doc.logicalPath, doc.revision, doc.contentHash]),
          threads.map((thread) => [
            thread.threadId,
            thread.excluded,
            thread.archived,
            thread.summaryStatus,
            thread.lastUpdatedAt,
          ]),
          coverage,
        ]),
      );
      if ((yield* Ref.get(digestInputSignatures)).get(projectId) === inputSignature) {
        return;
      }
      const running = {
        projectId,
        summary: previousSummary ?? "Generating project summary…",
        focusItems: lastGood?.focusItems ?? [],
        coverageFromSequence: lastGood?.coverageFromSequence ?? 0,
        coverageToSequence: digestActivity[0]?.sequence ?? lastGood?.coverageToSequence ?? 0,
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
        ...digestActivity.map((entry) => entry.id),
        ...tasks.map((task) => task.id),
        ...threads.map((thread) => thread.threadId),
        ...documents.map((doc) => doc.logicalPath),
      ]);
      const generated = yield* textGeneration
        .generateProjectDigest({
          cwd,
          previousSummary: previousSummary ?? undefined,
          activity: digestActivity.map((entry) => `${entry.id}: ${entry.summary}`).join("\n"),
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
        coverageToSequence: digestActivity[0]?.sequence ?? 0,
        historicalCoverage:
          coverage.pendingThreadCount > 0 ? ("partial" as const) : ("complete" as const),
        summarizedThreadCount: coverage.summarizedThreadCount,
        pendingThreadCount: coverage.pendingThreadCount,
        generationState: generated.error ? ("failed" as const) : ("idle" as const),
        generatedAt: generated.error ? (lastGood?.generatedAt ?? null) : isoNow(),
        lastGoodAt: generated.error ? (lastGood?.lastGoodAt ?? null) : isoNow(),
        lastError: normalizeDigestError(generated.error),
      };
      yield* repository
        .saveDigest(digest)
        .pipe(Effect.mapError(toServiceError("Failed to save digest.")));
      yield* Ref.update(digestInputSignatures, (signatures) =>
        new Map(signatures).set(projectId, inputSignature),
      );
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

  // Both link entry points (the user's linkProject and the coordinator's
  // synara_project_link_repository) run this body; only the recorded actor
  // differs.
  const linkProjectIntoGroup = (input: {
    readonly requestId: string;
    readonly projectId: ProjectId;
    readonly linkedProjectId: ProjectId;
    readonly actorKind: "user" | "coordinator";
    readonly actorThreadId: ThreadId | null;
  }) =>
    Effect.gen(function* () {
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
          actorKind: input.actorKind,
          actorThreadId: input.actorThreadId,
          goalId: null,
          taskId: null,
          source: null,
          summary: `Linked repository ${linked.title}`,
          createdAt: isoNow(),
        });
      }
      // Linking is a project-level relation, so it succeeds for a group the
      // user has not finished configuring yet (continue-as-group links before
      // onboarding saves) — only the config publish waits for one.
      const config = yield* repository
        .getConfig(input.projectId)
        .pipe(Effect.mapError(toServiceError("Failed to load project coordinator.")))
        .pipe(Effect.map(Option.getOrNull));
      if (config !== null) {
        yield* publish({ type: "config-upserted", config });
      }
      const overview = yield* buildOverview(input.projectId);
      yield* storeReceipt(input.requestId, input.projectId, "linkProject", overview);
      return overview;
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
            // Coordinator status is live: resolve it off the coordinator
            // thread's session/turn state (same inputs as the sidebar), so the
            // summaries feed reports "running" while a check-in turn is in
            // flight rather than deriving it from the goal lifecycle alone.
            const coordinatorShells = yield* snapshotQuery
              .getThreadShellsByIds(rows.map((row) => row.coordinatorThreadId))
              .pipe(Effect.catch(() => Effect.succeed([] as OrchestrationThreadShell[])));
            const coordinatorShellById = new Map(
              coordinatorShells.map((shell) => [shell.id, shell] as const),
            );
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
                coordinatorStatus: coordinatorStatusFromGoal(
                  true,
                  row.goalStatus,
                  coordinatorShellById.get(row.coordinatorThreadId) ?? null,
                ),
                revision: row.revision,
                pausedAt: row.pausedAt,
                archivedAt: row.archivedAt,
                memberThreadIds: [...new Set([row.coordinatorThreadId, ...row.memberThreadIds])],
                linkedProjectIds: row.linkedProjectIds,
                hasGoal:
                  row.goalStatus !== null || (row.goal !== null && row.goal.trim().length > 0),
                instructionsConfigured:
                  row.instructionsHash !== null && row.instructionsHash !== SEED_INSTRUCTIONS_HASH,
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
          // The stored coordinator selection is the rebind signal
          // ProviderCommandReactor keys off: saving an unusable provider would
          // tear the working session down and wedge every heartbeat check-in
          // behind a failed dispatch. Reject the whole save instead — the old
          // session keeps running and the settings form surfaces the error.
          const requestedProvider = input.coordinatorModelSelection.provider;
          const providerSettings = yield* serverSettingsService.getSettings.pipe(
            Effect.mapError(toServiceError("Failed to read provider settings.")),
          );
          if (!providerSettings.providers[requestedProvider].enabled) {
            return yield* Effect.fail(
              fail(providerDisabledSettingsMessage(requestedProvider), "invalid"),
            );
          }
          const providerStatus = (yield* providerHealth.getStatuses.pipe(
            Effect.mapError(toServiceError("Failed to read provider status.")),
          )).find((entry) => entry.provider === requestedProvider);
          if (providerStatus !== undefined && !providerStatus.available) {
            return yield* Effect.fail(
              fail(
                providerStatus.message ??
                  `${PROVIDER_DISPLAY_NAMES[requestedProvider]} is not installed or not on PATH.`,
                "invalid",
              ),
            );
          }
          const now = isoNow();
          const coordinatorName = input.coordinatorName ?? project.title;
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
              (thread) =>
                thread.deletedAt === null &&
                (thread.title === coordinatorName ||
                  thread.title === `${project.title} Coordinator`),
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
            // Pause/archive state is lifecycle-owned, never an editable
            // settings field — saving settings must not drop it.
            pausedAt: existingConfig?.pausedAt ?? null,
            archivedAt: existingConfig?.archivedAt ?? null,
            pausedAutomationIds: existingConfig?.pausedAutomationIds ?? [],
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
                    projectId: input.projectId,
                  }).pipe(
                    Effect.mapError(toServiceError("Failed to validate the new library path.")),
                  );
                  // Both queues are taken in canonical sorted order: equal
                  // keys (same folder via slash/default/symlink) collapse to
                  // one acquisition — the keyed locks are not re-entrant — and
                  // opposite moves cannot interleave into a deadlock.
                  const moveResult = yield* withLibraryQueues(
                    [previousRoot, nextRoot],
                    moveLibraryRoot({
                      fromRoot: previousRoot,
                      toRoot: nextRoot,
                      projectId: input.projectId,
                    }),
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
          const coordinatorModelChanged =
            Option.isSome(existing) &&
            !Equal.equals(
              existing.value.coordinatorModelSelection,
              input.coordinatorModelSelection,
            );
          if (coordinatorModelChanged) {
            // Apply the new model to the live coordinator thread. The stored
            // selection diverging from the bound session is the rebind signal
            // ProviderCommandReactor keys off: the next turn (or an immediate
            // restart when no turn is in flight) restarts the session on the
            // new provider/model and carries the transcript through the
            // prior-transcript bootstrap — the same mechanism Hand off uses.
            // Do not also dispatch thread.session.stop here: the explicit-stop
            // path clears pending context bootstraps, which would delete the
            // transcript carry the rebind just registered.
            yield* orchestrationEngine
              .dispatch({
                type: "thread.meta.update",
                commandId: branded.command(),
                threadId: coordinatorThreadId,
                modelSelection: input.coordinatorModelSelection,
                createdAt: now,
              } as OrchestrationCommand)
              .pipe(Effect.catch(() => Effect.void));
            if (latestConfig.automationId !== null) {
              yield* automationService
                .update({
                  id: latestConfig.automationId,
                  modelSelection: input.coordinatorModelSelection,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
            if (
              latestConfig.enabled &&
              latestConfig.pausedAt === null &&
              latestConfig.archivedAt === null &&
              latestConfig.automationId !== null
            ) {
              yield* automationService
                .runNow({ automationId: latestConfig.automationId })
                .pipe(Effect.catch(() => Effect.void));
            }
          }
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
        return yield* linkProjectIntoGroup({
          requestId: input.requestId,
          projectId: input.projectId,
          linkedProjectId: input.linkedProjectId,
          actorKind: "user",
          actorThreadId: null,
        });
      }),

    linkRepository: (input, principal) =>
      Effect.gen(function* () {
        if (!isCoordinatorPrincipal(principal, input.projectId)) {
          return yield* Effect.fail(
            fail("Only the group's coordinator can link a repository.", "forbidden"),
          );
        }
        const linkedProjectId = yield* Effect.gen(function* () {
          if (input.linkedProjectId !== undefined) return input.linkedProjectId;
          if (input.workspacePath === undefined) {
            return yield* Effect.fail(fail("Pass linkedProjectId or workspacePath.", "invalid"));
          }
          const project = yield* snapshotQuery
            .getActiveProjectByWorkspaceRoot(path.resolve(input.workspacePath))
            .pipe(Effect.mapError(toServiceError("Failed to resolve workspacePath.")));
          if (Option.isNone(project)) {
            return yield* Effect.fail(
              fail(`No Synara project owns workspace "${input.workspacePath}".`, "not-found"),
            );
          }
          return project.value.id;
        });
        return yield* linkProjectIntoGroup({
          requestId: input.requestId,
          projectId: input.projectId,
          linkedProjectId,
          actorKind: "coordinator",
          actorThreadId: principal.kind === "user" ? null : principal.threadId,
        });
      }),

    remember: (input, principal) =>
      Effect.gen(function* () {
        yield* requireProjectAccess(principal, input.projectId);
        if (principal.kind === "user" || principal.kind === "unmanaged") {
          return yield* Effect.fail(
            fail("Only group threads and the coordinator can save group memory.", "forbidden"),
          );
        }
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          input.projectId,
          (json) => JSON.parse(json) as { path: string; updated: boolean; deduplicated: boolean },
        );
        if (existingReceipt) return existingReceipt;
        const note = input.note.trim();
        // Titles land in the single-line index entry and `# heading` — control
        // characters (newlines especially) would inject fake `- [..](..)` rows.
        const title =
          sanitizeMemoryTitle(input.title ?? "") || memoryNoteSummary(note).slice(0, 60) || "Note";
        const existing = yield* readGroupMemoryNoteRevisions(input.projectId);
        const wanted = normalizeMemoryNote(note);
        const duplicate = existing.find((revision) => {
          const have = memoryNoteBody(revision.content);
          return (
            have === wanted ||
            (have.length >= 40 &&
              wanted.length >= 40 &&
              (have.includes(wanted) || wanted.includes(have)))
          );
        });
        if (duplicate) {
          const have = memoryNoteBody(duplicate.content);
          // "New note contains the old one" is a revision of the same memory:
          // write the longer body into the existing file instead of dropping
          // it or forking a suffixed sibling the index would double-list.
          const extendsExisting = wanted !== have && wanted.includes(have);
          if (extendsExisting) {
            yield* upsertSystemDocument({
              projectId: input.projectId,
              logicalPath: duplicate.logicalPath,
              content: `# ${title}\n\n${note}\n`,
              authorThreadId: principal.threadId,
            });
          }
          yield* updateMemoryIndex({
            projectId: input.projectId,
            logicalPath: duplicate.logicalPath,
            title,
            summary: memoryNoteSummary(note),
          });
          const result = {
            path: duplicate.logicalPath,
            updated: extendsExisting,
            deduplicated: true,
          };
          yield* storeReceipt(input.requestId, input.projectId, "remember", result);
          return result;
        }
        const existingPaths = new Set(existing.map((revision) => revision.logicalPath));
        const today = isoNow().slice(0, 10);
        const slug = slugifyMemoryTitle(title);
        let logicalPath = `memory/${today}-${slug}.md`;
        // Distinct notes that slug to the same dated path fork into `-2`,
        // `-3`… siblings; overwriting the unrelated note is never allowed.
        let counter = 2;
        while (existingPaths.has(logicalPath)) {
          logicalPath = `memory/${today}-${slug}-${counter}.md`;
          counter += 1;
        }
        const content = `# ${title}\n\n${note}\n`;
        yield* upsertSystemDocument({
          projectId: input.projectId,
          logicalPath,
          content,
          authorThreadId: principal.threadId,
        });
        yield* updateMemoryIndex({
          projectId: input.projectId,
          logicalPath,
          title,
          summary: memoryNoteSummary(note),
        });
        yield* appendActivity({
          projectId: input.projectId,
          kind: "document-written",
          actorKind: principal.kind === "coordinator" ? "coordinator" : "worker",
          actorThreadId: principal.threadId,
          goalId: null,
          taskId: principal.kind === "worker" ? principal.taskId : null,
          source: null,
          summary: `Remembered: ${title}`,
          createdAt: isoNow(),
        });
        const result = { path: logicalPath, updated: true, deduplicated: false };
        yield* storeReceipt(input.requestId, input.projectId, "remember", result);
        return result;
      }),

    forget: (input, principal) =>
      Effect.gen(function* () {
        yield* requireProjectAccess(principal, input.projectId);
        if (principal.kind === "user" || principal.kind === "unmanaged") {
          return yield* Effect.fail(
            fail("Only group threads and the coordinator can remove group memory.", "forbidden"),
          );
        }
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          input.projectId,
          (json) => JSON.parse(json) as { deleted: boolean },
        );
        if (existingReceipt) return existingReceipt;
        const logicalPath = yield* Effect.try({
          try: () => normalizeProjectDocumentPath(input.path),
          catch: () => fail(`Memory path "${input.path}" is not a valid document path.`, "invalid"),
        });
        if (!GROUP_MEMORY_NOTE_PATTERN.test(logicalPath)) {
          return yield* Effect.fail(
            fail(
              `Only group memory notes (memory/<date>-<slug>.md) can be forgotten.`,
              "forbidden",
            ),
          );
        }
        const head = yield* repository
          .getDocumentHead(input.projectId, logicalPath)
          .pipe(Effect.mapError(toServiceError("Failed to load group memory.")));
        if (Option.isNone(head)) {
          const result = { deleted: false };
          yield* storeReceipt(input.requestId, input.projectId, "forget", result);
          return result;
        }
        yield* repository
          .deleteDocument({ projectId: input.projectId, logicalPath })
          .pipe(Effect.mapError(toServiceError("Failed to remove group memory.")));
        yield* Effect.tryPromise({
          try: () =>
            fs.rm(materializeDocumentPath(serverConfig.stateDir, input.projectId, logicalPath), {
              force: true,
            }),
          catch: toServiceError("Failed to remove the memory mirror file."),
        });
        yield* updateMemoryIndex({
          projectId: input.projectId,
          logicalPath,
          title: "",
          summary: null,
        });
        yield* appendActivity({
          projectId: input.projectId,
          kind: "document-written",
          actorKind: principal.kind === "coordinator" ? "coordinator" : "worker",
          actorThreadId: principal.threadId,
          goalId: null,
          taskId: principal.kind === "worker" ? principal.taskId : null,
          source: null,
          summary: `Forgot memory ${logicalPath}`,
          createdAt: isoNow(),
        });
        const result = { deleted: true };
        yield* storeReceipt(input.requestId, input.projectId, "forget", result);
        return result;
      }),

    libraryList: (input, principal) =>
      Effect.gen(function* () {
        yield* requireProjectAccess(principal, input.projectId);
        return yield* withLibraryRootLock(
          input.projectId,
          Effect.gen(function* () {
            const { root, libraryIsManaged } = yield* resolveGroupLibraryRoot(input.projectId);
            const entries = yield* withLibraryQueue(
              root,
              Effect.gen(function* () {
                yield* ensureLibraryRepo(git, root, input.projectId, {
                  isManaged: libraryIsManaged,
                }).pipe(Effect.mapError(toServiceError("Failed to prepare the group library.")));
                return yield* listLibraryEntries(root, input.relativePath).pipe(
                  Effect.mapError(toServiceError("Failed to list the group library.")),
                );
              }),
            );
            return { root, entries };
          }),
        );
      }),

    libraryAdd: (input, principal) =>
      Effect.gen(function* () {
        yield* requireProjectAccess(principal, input.projectId);
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          input.projectId,
          (json) => JSON.parse(json) as { path: string; commitSha: string },
        );
        if (existingReceipt) return existingReceipt;
        return yield* withLibraryRootLock(
          input.projectId,
          Effect.gen(function* () {
            const { root, agentConfig, libraryIsManaged } = yield* resolveGroupLibraryRoot(
              input.projectId,
            );
            const { result, threadTitle } = yield* withLibraryQueue(
              root,
              Effect.gen(function* () {
                // Re-resolve inside the lock: checking containment before it
                // lets a swapped symlink redirect the copy after the check.
                const caller = yield* resolveLibraryCallerSource(principal, input.sourcePath);
                yield* ensureLibraryRepo(git, root, input.projectId, {
                  isManaged: libraryIsManaged,
                }).pipe(Effect.mapError(toServiceError("Failed to prepare the group library.")));
                yield* Effect.tryPromise({
                  try: () => fs.lstat(caller.source),
                  catch: () =>
                    fail(`Library source "${input.sourcePath}" was not found.`, "not-found"),
                });
                const baseName = path.basename(caller.source);
                const requested = yield* normalizeLibraryRelativePath(
                  input.destinationPath ?? baseName,
                ).pipe(
                  Effect.mapError(toServiceError("Failed to resolve the library destination.")),
                );
                let relativePath = requested;
                const existingDest = yield* Effect.tryPromise({
                  try: () => fs.stat(path.resolve(root, ...requested.split("/"))),
                  catch: () => "missing",
                }).pipe(Effect.catch(() => Effect.succeed(null)));
                if (existingDest !== null && existingDest.isDirectory()) {
                  relativePath = `${requested}/${baseName}`;
                }
                const target = yield* resolveLibraryWriteTarget(root, relativePath).pipe(
                  Effect.mapError(toServiceError("Failed to resolve the library destination.")),
                );
                yield* Effect.tryPromise({
                  try: () => copyLibrarySourceTree(caller.source, target),
                  catch: (cause) =>
                    cause instanceof LibraryAddTooLargeError
                      ? fail(cause.message, "invalid")
                      : toServiceError("Failed to copy into the group library.")(cause),
                });
                const { commitSha } = yield* commitLibraryChange(
                  git,
                  root,
                  `Add ${relativePath} from ${caller.threadTitle}`,
                ).pipe(Effect.mapError(toServiceError("Failed to commit the group library.")));
                return {
                  result: { path: relativePath, commitSha },
                  threadTitle: caller.threadTitle,
                };
              }),
            );
            yield* pushLibraryInBackground(root, agentConfig);
            yield* appendActivity({
              projectId: input.projectId,
              kind: "document-written",
              actorKind: principal.kind === "coordinator" ? "coordinator" : "worker",
              actorThreadId: principal.kind === "user" ? null : principal.threadId,
              goalId: null,
              taskId: principal.kind === "worker" ? principal.taskId : null,
              source: null,
              summary: `Added ${result.path} to the library from ${threadTitle}`,
              createdAt: isoNow(),
            });
            yield* storeReceipt(input.requestId, input.projectId, "libraryAdd", result);
            return result;
          }),
        );
      }),

    listGroupThreads: (input, principal) =>
      Effect.gen(function* () {
        if (!isCoordinatorPrincipal(principal, input.projectId)) {
          return yield* Effect.fail(
            fail("Only the group's coordinator can list group threads.", "forbidden"),
          );
        }
        yield* resolveGroupCoordinatorProject(input.projectId);
        const config = yield* requireConfig(input.projectId);
        const { index, tasks, shells } = yield* listGroupThreadShells({
          projectId: input.projectId,
          coordinatorThreadId: config.coordinatorThreadId,
        });
        const taskByThreadId = new Map(
          tasks
            .filter((task) => task.assignedThreadId !== null)
            .map((task) => [task.assignedThreadId!, task] as const),
        );
        const indexArchivedByThreadId = new Map(
          index.map((entry) => [entry.threadId, entry.archived] as const),
        );
        const workers = yield* repository
          .listManagedWorkers(input.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load managed workers.")));
        const needsYouByThreadId = new Map(
          workers
            .filter((worker) => worker.needsYou)
            .map((worker) => [worker.threadId, true] as const),
        );
        const projectShells = yield* snapshotQuery
          .getProjectShellsByIds([...new Set(shells.map((shell) => shell.projectId))])
          .pipe(Effect.mapError(toServiceError("Failed to load group projects.")));
        const projectTitleById = new Map(projectShells.map((shell) => [shell.id, shell.title]));
        const rows: ProjectAgentGroupThreadEntry[] = shells.map((shell) => {
          const task = taskByThreadId.get(shell.id) ?? null;
          const state = resolveGroupThreadState({
            thread: {
              archivedAt: shell.archivedAt ?? null,
              hasPendingApprovals: shell.hasPendingApprovals,
              hasPendingUserInput: shell.hasPendingUserInput,
              needsYou: needsYouByThreadId.has(shell.id),
              session: shell.session,
              latestTurn: shell.latestTurn,
            },
            task: task ? { status: task.status, archivedAt: task.archivedAt } : null,
            indexArchived: indexArchivedByThreadId.get(shell.id) ?? false,
            pullRequest: shell.lastKnownPr
              ? { state: shell.lastKnownPr.state, isDraft: shell.lastKnownPr.isDraft }
              : null,
          });
          return {
            threadId: shell.id,
            title: shell.title,
            projectId: shell.projectId,
            projectTitle: projectTitleById.get(shell.projectId) ?? null,
            state,
            stateLabel: groupThreadStateLabel(state),
            taskId: task?.id ?? null,
            pullRequestUrl: shell.lastKnownPr?.url ?? null,
            pullRequestState: shell.lastKnownPr?.state ?? null,
            pullRequestIsDraft: shell.lastKnownPr?.isDraft,
            updatedAt: shell.updatedAt,
          };
        });
        const order: Record<string, number> = {
          waiting: 0,
          working: 1,
          review: 2,
          landing: 3,
          idle: 4,
          resolved: 5,
        };
        rows.sort(
          (left, right) =>
            (order[left.state] ?? 9) - (order[right.state] ?? 9) ||
            (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
        );
        return { threads: rows };
      }),

    pauseGroup: (input, principal) =>
      withProjectLock(
        input.projectId,
        Effect.gen(function* () {
          yield* requireUserLifecycleAction("Pausing a group", principal);
          const existingReceipt = yield* replayReceipt(
            input.requestId,
            input.projectId,
            (json) => JSON.parse(json) as ProjectAgentOverview,
          );
          if (existingReceipt) return existingReceipt;
          yield* resolveGroupCoordinatorProject(input.projectId);
          const config = yield* requireConfig(input.projectId);
          if (config.pausedAt === null) {
            const disabledIds = yield* disableGroupAutomations(input.projectId);
            const now = isoNow();
            const saved = yield* repository
              .saveConfig(
                {
                  ...config,
                  pausedAt: now,
                  pausedAutomationIds: [
                    ...new Set([...(config.pausedAutomationIds ?? []), ...disabledIds]),
                  ],
                  revision: config.revision + 1,
                  updatedAt: now,
                },
                config.revision,
              )
              .pipe(Effect.mapError(toServiceError("Failed to pause the group.")));
            yield* publish({ type: "config-upserted", config: saved });
            // Interrupt live turns on the coordinator and member threads so a
            // paused group stops producing work immediately.
            const { shells } = yield* listGroupThreadShells({
              projectId: input.projectId,
              coordinatorThreadId: config.coordinatorThreadId,
            });
            const liveThreadIds = shells
              .filter(
                (shell) =>
                  shell.latestTurn?.state === "running" ||
                  shell.session?.status === "running" ||
                  shell.session?.status === "starting",
              )
              .map((shell) => shell.id);
            const coordinator = yield* snapshotQuery
              .getThreadShellById(config.coordinatorThreadId)
              .pipe(Effect.catch(() => Effect.succeed(Option.none())));
            const coordinatorLive =
              Option.isSome(coordinator) && coordinator.value.latestTurn?.state === "running";
            yield* dispatchGroupThreadCommand(
              coordinatorLive ? [config.coordinatorThreadId, ...liveThreadIds] : liveThreadIds,
              "thread.turn.interrupt",
            );
            yield* appendActivity({
              projectId: input.projectId,
              kind: "config-updated",
              actorKind: "user",
              actorThreadId: null,
              goalId: null,
              taskId: null,
              source: null,
              summary: "Paused group.",
              createdAt: isoNow(),
            });
          }
          const overview = yield* buildOverview(input.projectId);
          yield* storeReceipt(input.requestId, input.projectId, "pauseGroup", overview);
          return overview;
        }),
      ),

    resumeGroup: (input, principal) =>
      Effect.gen(function* () {
        const overview = yield* withProjectLock(
          input.projectId,
          Effect.gen(function* () {
            yield* requireUserLifecycleAction("Resuming a group", principal);
            const existingReceipt = yield* replayReceipt(
              input.requestId,
              input.projectId,
              (json) => JSON.parse(json) as ProjectAgentOverview,
            );
            if (existingReceipt) return existingReceipt;
            yield* resolveGroupCoordinatorProject(input.projectId);
            const config = yield* requireConfig(input.projectId);
            if (config.pausedAt !== null) {
              const restoreIds = config.pausedAutomationIds ?? [];
              yield* restoreGroupAutomations(restoreIds);
              const now = isoNow();
              const saved = yield* repository
                .saveConfig(
                  {
                    ...config,
                    pausedAt: null,
                    pausedAutomationIds: [],
                    revision: config.revision + 1,
                    updatedAt: now,
                  },
                  config.revision,
                )
                .pipe(Effect.mapError(toServiceError("Failed to resume the group.")));
              yield* publish({ type: "config-upserted", config: saved });
              yield* appendActivity({
                projectId: input.projectId,
                kind: "config-updated",
                actorKind: "user",
                actorThreadId: null,
                goalId: null,
                taskId: null,
                source: null,
                summary: "Resumed group.",
                createdAt: isoNow(),
              });
            }
            const next = yield* buildOverview(input.projectId);
            yield* storeReceipt(input.requestId, input.projectId, "resumeGroup", next);
            return next;
          }),
        );
        // Inbox events recorded while paused are still queued; a fresh wake
        // pass re-drives them now that the gate is open.
        yield* impl.processPendingWakes(input.projectId).pipe(Effect.catch(() => Effect.void));
        return overview;
      }),

    archiveGroup: (input, principal) =>
      withProjectLock(
        input.projectId,
        Effect.gen(function* () {
          yield* requireUserLifecycleAction("Archiving a group", principal);
          const existingReceipt = yield* replayReceipt(
            input.requestId,
            input.projectId,
            (json) => JSON.parse(json) as ProjectAgentOverview,
          );
          if (existingReceipt) return existingReceipt;
          yield* resolveGroupCoordinatorProject(input.projectId);
          const config = yield* requireConfig(input.projectId);
          if (config.archivedAt === null) {
            const disabledIds = yield* disableGroupAutomations(input.projectId);
            const now = isoNow();
            const saved = yield* repository
              .saveConfig(
                {
                  ...config,
                  archivedAt: now,
                  pausedAutomationIds: [
                    ...new Set([...(config.pausedAutomationIds ?? []), ...disabledIds]),
                  ],
                  revision: config.revision + 1,
                  updatedAt: now,
                },
                config.revision,
              )
              .pipe(Effect.mapError(toServiceError("Failed to archive the group.")));
            yield* publish({ type: "config-upserted", config: saved });
            const { shells } = yield* listGroupThreadShells({
              projectId: input.projectId,
              coordinatorThreadId: config.coordinatorThreadId,
            });
            // Only threads living IN the group project belong to the group —
            // linked-repo workers stay untouched.
            yield* dispatchGroupThreadCommand(
              [
                config.coordinatorThreadId,
                ...shells
                  .filter(
                    (shell) => shell.projectId === input.projectId && shell.archivedAt == null,
                  )
                  .map((shell) => shell.id),
              ],
              "thread.archive",
            );
            yield* appendActivity({
              projectId: input.projectId,
              kind: "config-updated",
              actorKind: "user",
              actorThreadId: null,
              goalId: null,
              taskId: null,
              source: null,
              summary: "Archived group.",
              createdAt: isoNow(),
            });
          }
          const overview = yield* buildOverview(input.projectId);
          yield* storeReceipt(input.requestId, input.projectId, "archiveGroup", overview);
          return overview;
        }),
      ),

    unarchiveGroup: (input, principal) =>
      Effect.gen(function* () {
        const overview = yield* withProjectLock(
          input.projectId,
          Effect.gen(function* () {
            yield* requireUserLifecycleAction("Unarchiving a group", principal);
            const existingReceipt = yield* replayReceipt(
              input.requestId,
              input.projectId,
              (json) => JSON.parse(json) as ProjectAgentOverview,
            );
            if (existingReceipt) return existingReceipt;
            yield* resolveGroupCoordinatorProject(input.projectId);
            const config = yield* requireConfig(input.projectId);
            if (config.archivedAt !== null) {
              // A group still paused keeps its automations off; resume is the
              // only lifecycle that restores them while pausedAt is set.
              const restoreIds = config.pausedAt === null ? (config.pausedAutomationIds ?? []) : [];
              yield* restoreGroupAutomations(restoreIds);
              const now = isoNow();
              const saved = yield* repository
                .saveConfig(
                  {
                    ...config,
                    archivedAt: null,
                    pausedAutomationIds:
                      config.pausedAt === null ? [] : (config.pausedAutomationIds ?? []),
                    revision: config.revision + 1,
                    updatedAt: now,
                  },
                  config.revision,
                )
                .pipe(Effect.mapError(toServiceError("Failed to unarchive the group.")));
              yield* publish({ type: "config-upserted", config: saved });
              const { shells } = yield* listGroupThreadShells({
                projectId: input.projectId,
                coordinatorThreadId: config.coordinatorThreadId,
              });
              yield* dispatchGroupThreadCommand(
                [
                  config.coordinatorThreadId,
                  ...shells
                    .filter(
                      (shell) => shell.projectId === input.projectId && shell.archivedAt != null,
                    )
                    .map((shell) => shell.id),
                ],
                "thread.unarchive",
              );
              yield* appendActivity({
                projectId: input.projectId,
                kind: "config-updated",
                actorKind: "user",
                actorThreadId: null,
                goalId: null,
                taskId: null,
                source: null,
                summary: "Unarchived group.",
                createdAt: isoNow(),
              });
            }
            const next = yield* buildOverview(input.projectId);
            yield* storeReceipt(input.requestId, input.projectId, "unarchiveGroup", next);
            return next;
          }),
        );
        if (overview.config?.pausedAt == null) {
          yield* impl.processPendingWakes(input.projectId).pipe(Effect.catch(() => Effect.void));
        }
        return overview;
      }),

    restartCoordinator: (input, principal) =>
      Effect.gen(function* () {
        yield* requireUserLifecycleAction("Restarting the coordinator", principal);
        const existingReceipt = yield* replayReceipt(
          input.requestId,
          input.projectId,
          (json) => JSON.parse(json) as ProjectAgentOverview,
        );
        if (existingReceipt) return existingReceipt;
        yield* resolveGroupCoordinatorProject(input.projectId);
        const config = yield* requireConfig(input.projectId);
        if (config.pausedAt !== null || config.archivedAt !== null) {
          return yield* Effect.fail(
            fail("Resume or unarchive the group before restarting its coordinator.", "conflict"),
          );
        }
        yield* orchestrationEngine
          .dispatch({
            type: "thread.session.stop",
            commandId: branded.command(),
            threadId: config.coordinatorThreadId,
            createdAt: isoNow(),
          } as OrchestrationCommand)
          .pipe(Effect.catch(() => Effect.void));
        if (config.enabled && config.automationId !== null) {
          yield* automationService
            .runNow({ automationId: config.automationId })
            .pipe(Effect.mapError(toServiceError("Failed to restart the coordinator.")));
        }
        yield* appendActivity({
          projectId: input.projectId,
          kind: "config-updated",
          actorKind: "user",
          actorThreadId: null,
          goalId: null,
          taskId: null,
          source: null,
          summary: "Restarted coordinator.",
          createdAt: isoNow(),
        });
        const overview = yield* buildOverview(input.projectId);
        yield* storeReceipt(input.requestId, input.projectId, "restartCoordinator", overview);
        return overview;
      }),

    deleteGroup: (input, principal) =>
      withProjectLock(
        input.projectId,
        Effect.gen(function* () {
          yield* requireUserLifecycleAction("Deleting a group", principal);
          const existingReceipt = yield* replayReceipt(
            input.requestId,
            input.projectId,
            (json) => JSON.parse(json) as ProjectAgentDeleteGroupResult,
          );
          if (existingReceipt) return existingReceipt;
          const project = yield* resolveGroupCoordinatorProject(input.projectId);
          if (input.confirmName.trim() !== project.title.trim()) {
            return yield* Effect.fail(
              fail("Type the group's name exactly to confirm deletion.", "forbidden"),
            );
          }
          const result = yield* withLibraryRootLock(
            input.projectId,
            Effect.gen(function* () {
              const agentConfig = yield* repository
                .getConfig(input.projectId)
                .pipe(Effect.mapError(toServiceError("Failed to load project coordinator.")))
                .pipe(Effect.map(Option.getOrNull));
              // Collect group threads up front: deleteProjectData wipes the
              // thread index, and project.delete only accepts a threadless
              // project, so every group thread must be dispatched for deletion
              // before the project delete.
              const { index, tasks, shells } = yield* listGroupThreadShells({
                projectId: input.projectId,
                coordinatorThreadId: agentConfig?.coordinatorThreadId ?? null,
              });
              // Only threads living IN the group project are deleted —
              // linked-repo workers are detached (their task rows die with the
              // group's data) and left running.
              const groupShells = shells.filter((shell) => shell.projectId === input.projectId);
              const root = yield* resolveLibraryRoot({
                stateDir: serverConfig.stateDir,
                projectId: input.projectId,
                libraryPath: agentConfig?.libraryPath,
              }).pipe(Effect.mapError(toServiceError("Failed to resolve the group library.")));
              const libraryIsCustom = agentConfig?.libraryPath !== undefined;
              if (!libraryIsCustom) {
                yield* assertLibraryRootLocation({
                  root,
                  stateDir: serverConfig.stateDir,
                  groupsWorkspaceRoot: serverConfig.groupsWorkspaceRoot,
                  studioWorkspaceRoot: serverConfig.studioWorkspaceRoot,
                  isCustomPath: false,
                  projectId: input.projectId,
                }).pipe(Effect.mapError(toServiceError("Failed to resolve the group library.")));
              }
              if (input.requireEmpty === true) {
                // The dialog-side "still empty" probe is a hint, not a guard —
                // anything could have landed between it and this delete.
                // Re-check under the lock before tearing anything down: no
                // member threads, no tasks, only untouched seed documents,
                // and nothing in the library.
                // A group created seconds ago may not have a library dir on
                // disk at all — a missing root is an empty library, while any
                // other inspection failure should refuse the delete.
                const rootStat = yield* Effect.tryPromise({
                  try: async () => {
                    try {
                      return await fs.stat(root);
                    } catch (error) {
                      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                      throw error;
                    }
                  },
                  catch: () =>
                    new ProjectAgentServiceError({
                      message: "Could not inspect the group's library.",
                      code: "invalid",
                    }),
                });
                const listTopEntries =
                  rootStat === null || !rootStat.isDirectory()
                    ? ([] as ReadonlyArray<LibraryEntry>)
                    : yield* listLibraryEntries(root).pipe(
                        Effect.catch((error: LibraryError) =>
                          error.code === "not-found"
                            ? Effect.succeed<ReadonlyArray<LibraryEntry>>([])
                            : Effect.fail(error),
                        ),
                        Effect.mapError(toServiceError("Failed to list the group library.")),
                      );
                // The seeded Artifacts/ scaffold (holding only the marker /
                // keep files listLibraryEntries filters out) is not content —
                // a group is empty while it is the only top-level entry and
                // itself lists nothing.
                let libraryEmpty = listTopEntries.length === 0;
                if (
                  !libraryEmpty &&
                  listTopEntries.length === 1 &&
                  listTopEntries[0]!.name === "Artifacts" &&
                  listTopEntries[0]!.kind === "directory"
                ) {
                  const artifactsEntries = yield* listLibraryEntries(root, "Artifacts").pipe(
                    Effect.catch((error: LibraryError) =>
                      error.code === "not-found"
                        ? Effect.succeed<ReadonlyArray<LibraryEntry>>([])
                        : Effect.fail(error),
                    ),
                    Effect.mapError(toServiceError("Failed to list the group library.")),
                  );
                  libraryEmpty = artifactsEntries.length === 0;
                }
                const documentHeads = yield* repository
                  .listDocumentHeads(input.projectId)
                  .pipe(Effect.mapError(toServiceError("Failed to load group documents.")));
                const seedContentByPath = new Map(
                  SEED_DOCUMENTS.map((seed) => [seed.path, seed.content]),
                );
                const documentsPristine = documentHeads.every((head) => {
                  const seeded = seedContentByPath.get(head.logicalPath);
                  return seeded !== undefined && head.contentHash === hashDocumentContent(seeded);
                });
                const coordinatorThreadId = agentConfig?.coordinatorThreadId ?? null;
                const threadsPristine =
                  index.every((entry) => entry.threadId === coordinatorThreadId) &&
                  tasks.length === 0 &&
                  shells.length === 0;
                if (!threadsPristine || !documentsPristine || !libraryEmpty) {
                  return yield* Effect.fail(
                    fail(
                      "This group is no longer empty — finish setup or delete it from the group's settings.",
                      "conflict",
                    ),
                  );
                }
              }
              // Threads first, and stop on any failure: a thread that refuses
              // to delete must abort the whole delete while the group is still
              // fully intact — the alternative is a half-deleted group whose
              // coordinator data and library are already gone.
              yield* dispatchGroupThreadCommand(
                [
                  ...(agentConfig?.coordinatorThreadId ? [agentConfig.coordinatorThreadId] : []),
                  ...groupShells.map((shell) => shell.id),
                ],
                "thread.delete",
                { stopOnError: true },
              );
              yield* orchestrationEngine
                .dispatch({
                  type: "project.delete",
                  commandId: branded.command(),
                  projectId: input.projectId,
                  createdAt: isoNow(),
                } as OrchestrationCommand)
                .pipe(Effect.mapError(toServiceError("Failed to delete the group project.")));
              // Only once the project is gone: automations, coordinator rows,
              // the context mirror, and the managed library come down too.
              const listed = yield* automationService
                .list({ projectId: input.projectId, includeArchived: true })
                .pipe(Effect.mapError(toServiceError("Failed to load group automations.")));
              for (const definition of listed.definitions) {
                yield* automationService
                  .delete({ id: definition.id })
                  .pipe(Effect.catch(() => Effect.void));
              }
              yield* repository
                .deleteProjectData(input.projectId)
                .pipe(Effect.mapError(toServiceError("Failed to delete group coordinator data.")));
              let libraryLeftOnDiskPath: string | null = null;
              if (libraryIsCustom) {
                // A user-chosen library folder is never moved or deleted.
                if (yield* libraryPathExists(root)) libraryLeftOnDiskPath = root;
              } else if (yield* libraryPathExists(root)) {
                // The managed library lives under the context root — trash it
                // before the context dir is removed or it is gone for good.
                const moved = yield* moveLibraryToTrash(root);
                if (!moved) libraryLeftOnDiskPath = root;
              }
              // The context mirror directory is app-owned state (documents +
              // the managed default library root when it lived under
              // project-context).
              yield* Effect.tryPromise({
                try: () =>
                  fs.rm(projectContextRoot(serverConfig.stateDir, input.projectId), {
                    recursive: true,
                    force: true,
                  }),
                catch: toServiceError("Failed to remove group context files."),
              });
              // The managed group workspace folder only gets removed when
              // nothing but Synara-generated instructions remain inside; any
              // user files keep it on disk and the path goes back to the UI.
              const workspaceCleanup = yield* cleanupGroupWorkspaceRoot({
                workspaceRoot: project.workspaceRoot,
                groupsWorkspaceRoot: serverConfig.groupsWorkspaceRoot,
              });
              const workspaceLeftOnDiskPath =
                workspaceCleanup.status === "kept" ? workspaceCleanup.workspaceRoot : null;
              const deleted: ProjectAgentDeleteGroupResult = {
                deletedProjectId: input.projectId,
                libraryLeftOnDiskPath,
                workspaceLeftOnDiskPath,
              };
              return deleted;
            }),
          );
          yield* storeReceipt(input.requestId, input.projectId, "deleteGroup", result);
          return result;
        }),
      ),

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
        // User notes under memory/notes/ are user-owned writes, but threads
        // only ever read MEMORY.md — index them like remember-tool notes so
        // every group thread can reach them.
        if (isMemoryNoteDocumentPath(logicalPath)) {
          const firstLine = content.split("\n").find((line) => line.trim().length > 0) ?? "";
          const title = sanitizeMemoryTitle(firstLine.replace(/^#+\s*/, "")).slice(0, 60) || "Note";
          yield* updateMemoryIndex({
            projectId: input.projectId,
            logicalPath,
            title,
            summary: memoryNoteSummary(content.replace(/^#[^\n]*\n/, "")),
          });
        }
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
        yield* publishThreadIndexUpserts(input.projectId, [entry]);
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
        const groupGoal = Option.isSome(config) ? (config.value.goal?.trim() ?? "") : "";
        const memoryEnabled = Option.isSome(config)
          ? Boolean(config.value.autoMemoryEnabled)
          : false;
        // The MEMORY.md index is loaded for every group thread — threads
        // discover group memory through it regardless of the auto-memory
        // switch, which only governs the extra memory/threads/ packet docs.
        const memoryIndex = yield* repository
          .readDocumentRevision({
            projectId: principal.projectId,
            logicalPath: MEMORY_AUTO_DOCUMENT_PATH,
          })
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        const memoryIndexText =
          Option.isSome(memoryIndex) && memoryIndex.value.content.trim().length > 0
            ? memoryIndex.value.content.trim()
            : "Empty. Save group-wide memory with synara_project_remember.";
        const groupLibraryRoot = Option.isSome(config)
          ? yield* resolveGroupLibraryRoot(principal.projectId)
              .pipe(Effect.map(({ root }) => root))
              .pipe(Effect.catch(() => Effect.succeed("unavailable")))
          : "unavailable";
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
        const activeGoalObjective = packet.goal?.objective?.trim() ?? "";
        // The budget cuts the tail, so ordering is priority: the user's
        // instructions and the memory index lead; rebuildable state (worker
        // reports, memory files, decisions, tasks) trails and truncates first.
        const budget = truncateToContextBudget([
          { label: "Instructions", text: packet.instructions },
          { label: "Group memory index", text: memoryIndexText },
          ...(isCoordinatorLike
            ? [
                {
                  label: "Playbook",
                  text: Option.isSome(playbook) ? playbook.value.content : PROJECT_BOT_PLAYBOOK,
                },
              ]
            : []),
          ...(groupGoal ? [{ label: "Objective", text: groupGoal }] : []),
          // An active goal restating the group objective is shown once, as
          // Objective — not under both labels.
          ...(groupGoal.length > 0 && activeGoalObjective === groupGoal
            ? []
            : [
                {
                  label: "Goal",
                  text:
                    packet.goal?.objective ?? "None. Only create a goal if the user asked for one.",
                },
              ]),
          ...(principal.kind === "coordinator"
            ? []
            : [
                {
                  label: "Group tools",
                  text: "Save shared group memory with synara_project_remember; deliver files to the group Library with synara_project_library_add — sources must be inside your own workspace.",
                },
              ]),
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
          // The group's default for new threads is the configured worker
          // routing; a thread may still override it per instruction.
          {
            label: "Thread model default",
            text:
              Option.isSome(config) && config.value.workerRouting?.modelSelection !== undefined
                ? `${config.value.workerRouting.modelSelection.provider} ${config.value.workerRouting.modelSelection.model}`
                : "Provider default.",
          },
          { label: "Library root", text: groupLibraryRoot },
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
          ...(memoryEnabled ? [{ label: "Memory", text: memorySections.join("\n\n") }] : []),
          { label: "Decisions", text: packet.relevantDecisions },
          {
            label: "Tasks",
            text: packet.tasks.map((task) => `- ${task.status} ${task.title}`).join("\n"),
          },
        ]);
        return [
          "Group context packet (authoritative durable state; additional documents via synara_project_read_document):",
          principal.kind === "coordinator"
            ? "This thread opened with a welcome message from you; the user may be replying to it."
            : "You are a member thread of this group, not its coordinator — the coordinator's welcome lives on the coordinator's own thread.",
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
        // createdAt feeds the never-started grace, which runs on Clock time.
        const clockCreatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        const goal = yield* repository
          .getActiveGoal(principal.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load authorized goal.")));
        const activeGoal =
          Option.isSome(goal) && goal.value.status === "active" ? goal.value : null;
        const batchId = input.batchId ?? input.requestId;
        for (const [index, threadId] of input.threadIds.entries()) {
          const title = input.titles[index] ?? `Worker ${index + 1}`;
          const indexEntry = {
            projectId: principal.projectId,
            threadId,
            excluded: false,
            archived: false,
            summaryStatus: "pending" as const,
            lastUpdatedAt: now,
            lastSummarizedAt: null,
          };
          yield* repository
            .upsertThreadIndex(indexEntry)
            .pipe(Effect.mapError(toServiceError("Failed to index worker thread.")));
          yield* publishThreadIndexUpserts(principal.projectId, [indexEntry]);
          let taskId: ProjectTaskId | null = null;
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
            taskId = task.id;
          }
          // Every coordinator-created thread is a tracked worker — the durable
          // record drives settle rows, the batch roll-up, and stuck detection
          // even when no active goal produced a task for it. The task prompt
          // is stored so the stall-recovery ladder can re-dispatch it after a
          // restart without re-reading the thread.
          yield* repository
            .upsertManagedWorker({
              projectId: principal.projectId,
              threadId,
              batchId,
              requestId: input.requestId,
              title,
              taskId,
              settledAt: null,
              settleOutcome: null,
              waitingSince: null,
              stuckKind: null,
              stuckSince: null,
              taskPrompt: input.prompts?.[index] ?? null,
              recoveryEpisode: null,
              recoveryStep: 0,
              nudgeAt: null,
              recoveriesUsed: 0,
              needsYou: false,
              needsYouAt: null,
              activeTurnOrigin: "coordinator",
              activeTurnCommandId: null,
              resultSummary: null,
              resultAt: null,
              createdAt: clockCreatedAt,
              updatedAt: clockCreatedAt,
            })
            .pipe(Effect.mapError(toServiceError("Failed to track managed worker.")));
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
        // The structured summary lands on the managed-worker row — the settle
        // row and the batch roll-up quote it instead of generic text.
        if (principal.kind !== "user") {
          const workerOption = yield* repository
            .findManagedWorkerByThread(principal.threadId)
            .pipe(Effect.catch(() => Effect.succeed(Option.none())));
          if (Option.isSome(workerOption)) {
            const worker = workerOption.value;
            yield* repository
              .saveManagedWorkerMonitor({
                worker: {
                  ...worker,
                  resultSummary: input.summary,
                  resultAt: now,
                  updatedAt: now,
                },
                expectedUpdatedAt: worker.updatedAt,
              })
              .pipe(Effect.catch(() => Effect.void));
          }
        }
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
        const worker = yield* repository
          .findManagedWorkerByThread(input.threadId)
          .pipe(Effect.mapError(toServiceError("Failed to resolve managed worker for event.")));
        const configByCoordinator = yield* repository
          .getConfigByCoordinatorThread(input.threadId)
          .pipe(Effect.mapError(toServiceError("Failed to resolve coordinator for event.")));
        const shell = yield* snapshotQuery
          .getThreadShellById(input.threadId)
          .pipe(Effect.mapError(toServiceError("Failed to resolve thread for event.")));
        const projectId = Option.isSome(task)
          ? task.value.projectId
          : Option.isSome(worker)
            ? worker.value.projectId
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
        // A diff-completed event whose checkpoint closed missing/error belongs
        // to a turn that did not finish cleanly — e.g. a turn the recovery
        // ladder itself interrupted. Reclassify it so everything downstream
        // treats it as an interruption (never `completed`): no false
        // "finished" row, and the recovery counter is not reset by the
        // ladder's own interrupt.
        const eventType =
          input.eventType === "thread.turn-diff-completed" &&
          input.checkpointStatus !== undefined &&
          input.checkpointStatus !== "ready"
            ? "worker.interrupted"
            : input.eventType;
        if (Option.isSome(configByCoordinator)) {
          // Coordinator self-events never wake coordination. Automation
          // "check-in" turns additionally stay out of the coordinator
          // transcript entirely — the activity log records what each check-in
          // concluded instead.
          let summary = "Coordinator self-events do not wake coordination.";
          let kind: ProjectActivityKind = "wake-skipped";
          if (input.eventType === "thread.turn-diff-completed" && input.turnId !== undefined) {
            const detail = yield* snapshotQuery
              .getThreadDetailById(input.threadId)
              .pipe(Effect.catch(() => Effect.succeed(Option.none())));
            const checkin = Option.isSome(detail)
              ? coordinatorCheckinTurnReport({
                  messages: detail.value.messages,
                  turnId: input.turnId,
                })
              : null;
            if (checkin !== null) {
              kind = "coordinator-checkin";
              summary =
                checkin.silent || checkin.replyText === null
                  ? "Coordinator check-in: nothing to report."
                  : `Coordinator check-in: ${checkin.replyText.trim().slice(0, 500)}`;
            }
          }
          yield* appendActivity({
            projectId,
            kind,
            actorKind: "system",
            actorThreadId: input.threadId,
            goalId: null,
            taskId: null,
            source: null,
            summary,
            createdAt: input.createdAt,
          });
          // Coordinator turns still change what the digest should say (tasks
          // dispatched, docs written, memory saved) — the self-event early
          // return used to skip this, so Focus kept the stale summary.
          yield* impl.scheduleDigest(projectId);
          return;
        }
        // A worker is a tracked thread: a task assignment or a recorded
        // managed worker (coordinator-created with or without an active goal).
        // Wakes come from those threads or from any group thread that ends in
        // an alert (error / needs the user) — never from routine group chats.
        // For managed workers the wake set is narrower: ladder bookkeeping
        // (silent/nudged/redispatched/waiting-overdue/never-started/… )
        // posts its rows but never burns a coordinator turn; the model is
        // woken only when the ladder gives up or the worker settles.
        const managedWorker = Option.isSome(task) || Option.isSome(worker);
        const eligibleWake = managedWorker
          ? WORKER_WAKE_EVENT_TYPES.has(eventType)
          : isWorkerAlertEvent(eventType);
        // Paused/archived groups still record state (inbox event, worker row,
        // settlement report) — only the coordinator-thread rows suppress.
        const suppressRows = config.value.pausedAt != null || config.value.archivedAt != null;
        const inserted = yield* repository
          .insertInboxEvent({
            id: branded.inbox(),
            projectId,
            sourceThreadId: input.threadId,
            sourceEventId: input.sourceEventId,
            eventType,
            taskId: Option.isSome(task) ? task.value.id : null,
            eligibleWake,
            createdAt: input.createdAt,
          })
          .pipe(Effect.mapError(toServiceError("Failed to record project inbox event.")));
        const shouldReport = managedWorker && shouldMaterializeWorkerSettlementReport(eventType);
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
            eventType,
            sessionStatus: Option.isSome(shell) ? shell.value.session?.status : null,
          });
          const report = formatWorkerSettlementReport({
            title,
            threadId: input.threadId,
            eventType,
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
        // Deterministic monitoring: the fresh event posts its compact system
        // row into the coordinator thread and, once every worker in the same
        // creation batch has settled, the single roll-up row. The wake below
        // then hands the coordinator a turn to react.
        if (Option.isSome(worker)) {
          yield* recordWorkerMonitorEvent({
            worker: worker.value,
            eventType,
            sourceEventId: input.sourceEventId,
            createdAt: input.createdAt,
            coordinatorThreadId: config.value.coordinatorThreadId,
            taskId: Option.isSome(task) ? task.value.id : null,
            lastKnownPr: Option.isSome(shell) ? (shell.value.lastKnownPr ?? null) : null,
            suppressRows,
          });
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
          // Paused/archived groups refuse coordinator wakes. The inbox rows
          // stay recorded, so resume/unarchive re-drives the backlog.
          if (config.pausedAt !== null || config.archivedAt !== null) return;
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
            const existingWake = yield* readWakeReceipt(projectId, receiptId);
            let runId = existingWake?.runId;
            if (!runId) {
              if (!config.automationId) {
                yield* clearWakeCursor(projectId, cursor);
                return;
              }
              // A busy marker younger than the live window while the
              // coordinator thread is mid-turn (or awaiting approvals) is live
              // work, not a crash — leave the range frozen for the next wake
              // instead of stacking a second continuation on top of it.
              if (cursor.coordinatorBusySince !== null) {
                const busyAge = Date.now() - Date.parse(cursor.coordinatorBusySince);
                if (busyAge < COORDINATOR_BUSY_LIVE_MS) {
                  const coordinator = yield* snapshotQuery
                    .getThreadShellById(config.coordinatorThreadId)
                    .pipe(Effect.mapError(toServiceError("Failed to load coordinator thread.")));
                  const midTurn =
                    Option.isSome(coordinator) &&
                    (coordinator.value.latestTurn?.state === "running" ||
                      coordinator.value.hasPendingApprovals === true);
                  if (midTurn) return;
                }
              }
              const dispatch = yield* dispatchWakeContinuation({
                projectId,
                receiptId,
                automationId: config.automationId,
                existingWake,
              });
              if (dispatch.runId === null) return;
              runId = dispatch.runId;
              if (dispatch.dispatched && activeGoal) {
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
            // The keyset cursor needs the frozen range's last row's createdAt;
            // fetch the boundary row by id — a page scan can miss a row that
            // sits beyond the window and would keep a stale timestamp.
            const toRow = yield* repository
              .getInboxEvent({ projectId, inboxId: toInboxId })
              .pipe(Effect.mapError(toServiceError("Failed to load frozen inbox boundary.")));
            yield* repository
              .saveCursor({
                projectId,
                processedThroughInboxId: toInboxId,
                processedThroughCreatedAt: Option.isSome(toRow)
                  ? toRow.value.createdAt
                  : cursor.processedThroughCreatedAt,
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
          // Pages the inbox until a wake-eligible row appears or the tail is
          // exhausted. Every consumed row advances the keyset cursor, so a
          // page of non-wake rows can no longer hide later worker alerts
          // behind the 50-row read window.
          let eligible: ReadonlyArray<ProjectInboxEvent> = [];
          let scanAfterId = cursor.processedThroughInboxId;
          let scanAfterCreatedAt = cursor.processedThroughCreatedAt;
          for (;;) {
            const pending = yield* repository
              .listInboxAfter({
                projectId,
                afterCreatedAt: scanAfterCreatedAt,
                afterId: scanAfterId,
                limit: 50,
              })
              .pipe(Effect.mapError(toServiceError("Failed to load project inbox.")));
            if (pending.length === 0) break;
            const found = pending.filter((event) => event.eligibleWake);
            if (found.length > 0) {
              eligible = found;
              break;
            }
            const last = pending[pending.length - 1]!;
            yield* repository
              .saveCursor({
                projectId,
                processedThroughInboxId: last.id,
                processedThroughCreatedAt: last.createdAt,
                frozenFromInboxId: null,
                frozenToInboxId: null,
                coordinatorBusy: false,
                coordinatorBusySince: null,
                updatedAt: isoNow(),
              })
              .pipe(Effect.mapError(toServiceError("Failed to advance project event cursor.")));
            scanAfterId = last.id;
            scanAfterCreatedAt = last.createdAt;
          }
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
          const existingWake = yield* readWakeReceipt(projectId, receiptId);
          yield* repository
            .saveCursor({
              projectId,
              processedThroughInboxId: scanAfterId,
              processedThroughCreatedAt: scanAfterCreatedAt,
              frozenFromInboxId: fromInboxId,
              frozenToInboxId: toInboxId,
              coordinatorBusy: true,
              coordinatorBusySince: isoNow(),
              updatedAt: isoNow(),
            })
            .pipe(Effect.mapError(toServiceError("Failed to freeze project event range.")));
          let runId = existingWake?.runId;
          if (!runId) {
            const dispatch = yield* dispatchWakeContinuation({
              projectId,
              receiptId,
              automationId: config.automationId,
              existingWake,
            });
            if (dispatch.runId === null) return;
            runId = dispatch.runId;
            if (dispatch.dispatched && activeGoal) {
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
        // One live listing per tick powers the disconnect check: a session
        // whose projection says running but that no provider adapter owns is
        // a dead process. A failed listing (null) skips just that check —
        // never every check.
        const liveSessions = yield* providerService
          .listSessions()
          .pipe(Effect.catch(() => Effect.succeed(null)));
        const liveWorkerThreadIds =
          liveSessions === null
            ? null
            : new Set<string>(
                liveSessions
                  .filter(
                    (session: ProviderSession) =>
                      session.status !== "error" && session.status !== "closed",
                  )
                  .map((session: ProviderSession) => session.threadId),
              );
        for (const config of configs) {
          if (!config.enabled) continue;
          if (config.pausedAt !== null || config.archivedAt !== null) continue;
          // Only tracked workers are checked. Ordinary group chats stay
          // indexed for context but a healthy idle/finished one must never
          // produce reports, wakes, or digests. Managed workers additionally
          // get the quiet/waiting stuck checks.
          const workerThreadIds = yield* assignedWorkerThreadIds(config.projectId);
          const workers = yield* repository
            .listManagedWorkers(config.projectId)
            .pipe(Effect.mapError(toServiceError("Failed to load managed workers.")));
          const workerByThread = new Map(workers.map((worker) => [worker.threadId, worker]));
          for (const threadId of workerThreadIds) {
            if (threadId === config.coordinatorThreadId) {
              continue;
            }
            const shell = yield* snapshotQuery
              .getThreadShellById(threadId)
              .pipe(Effect.catch(() => Effect.succeed(Option.none())));
            const worker = workerByThread.get(threadId);
            if (worker !== undefined) {
              yield* inspectManagedWorkerHealth({ worker, shell, liveWorkerThreadIds });
              continue;
            }
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

    recordWorkerTurnRequest: (input) =>
      Effect.gen(function* () {
        // `thread.turn-queued` only enqueues the request behind whatever turn
        // is running — the running turn keeps its ownership until promotion
        // emits `thread.turn-start-requested`. Flipping ownership here would
        // let a queued coordinator message claim a running user turn.
        if (input.eventType === "thread.turn-queued") return;
        const existing = yield* repository
          .findManagedWorkerByThread(input.threadId)
          .pipe(Effect.mapError(toServiceError("Failed to load managed worker.")));
        if (Option.isNone(existing)) return;
        const worker = existing.value;
        // Turn ownership: "user" requests belong to the person at the
        // keyboard; ladder-originated commands carry the recovery prefix;
        // everything else (coordinator dispatch, automation wake) monitors
        // as "coordinator".
        const origin =
          input.dispatchOrigin === "user"
            ? ("user" as const)
            : input.commandId !== null && input.commandId.startsWith(WORKER_RECOVERY_COMMAND_PREFIX)
              ? ("ladder" as const)
              : ("coordinator" as const);
        const updated: ProjectManagedWorker = {
          ...worker,
          activeTurnOrigin: origin,
          activeTurnCommandId: input.commandId ?? worker.activeTurnCommandId,
          // Re-arm: a new coordinator/ladder turn on a settled worker re-opens
          // monitoring — the next settle reports again.
          ...(origin !== "user"
            ? {
                settledAt: null,
                settleOutcome: null,
                waitingSince: null,
                needsYou: false,
                needsYouAt: null,
              }
            : {}),
          updatedAt: input.createdAt,
        };
        const saved = yield* repository
          .saveManagedWorkerMonitor({
            worker: updated,
            expectedUpdatedAt: worker.updatedAt,
          })
          .pipe(Effect.catch(() => Effect.succeed({ applied: false as const })));
        if (!saved.applied) {
          // CAS miss — a ladder claim or settle landed in between. Re-read
          // once and apply the ownership facts on top so the mark isn't lost.
          const fresh = yield* repository
            .findManagedWorkerByThread(input.threadId)
            .pipe(Effect.catch(() => Effect.succeed(Option.none())));
          if (Option.isSome(fresh)) {
            const retried: ProjectManagedWorker = {
              ...updated,
              // Keep the ladder/monitor state the winner wrote; only the
              // ownership + re-arm fields are reapplied.
              stuckKind: fresh.value.stuckKind,
              stuckSince: fresh.value.stuckSince,
              recoveryEpisode: fresh.value.recoveryEpisode,
              recoveryStep: fresh.value.recoveryStep,
              nudgeAt: fresh.value.nudgeAt,
              recoveriesUsed: fresh.value.recoveriesUsed,
              needsYou: fresh.value.needsYou,
              needsYouAt: fresh.value.needsYouAt,
              updatedAt: fresh.value.updatedAt,
            };
            yield* repository
              .saveManagedWorkerMonitor({
                worker: retried,
                expectedUpdatedAt: fresh.value.updatedAt,
              })
              .pipe(Effect.catch(() => Effect.void));
          }
        }
      }),

    resolveWorkerAlert: (input: ProjectAgentResolveWorkerInput, principal) =>
      Effect.gen(function* () {
        if (!isUserPrincipal(principal)) {
          return yield* Effect.fail(
            fail("Only the signed-in user can resolve worker alerts.", "forbidden"),
          );
        }
        const config = yield* repository
          .getConfig(input.projectId)
          .pipe(Effect.mapError(toServiceError("Failed to load project coordinator.")));
        if (Option.isNone(config)) {
          return yield* Effect.fail(fail("Project coordinator not found.", "not-found"));
        }
        const workerOption = yield* repository
          .findManagedWorkerByThread(input.threadId)
          .pipe(Effect.mapError(toServiceError("Failed to load managed worker.")));
        if (Option.isNone(workerOption) || workerOption.value.projectId !== input.projectId) {
          return yield* Effect.fail(fail("Managed worker not found.", "not-found"));
        }
        const worker = workerOption.value;
        const nowIso = isoNow();
        // Persist the resolve decision with CAS on the row's updatedAt; on a
        // miss re-read once and reapply the resolve-owned fields — a swallowed
        // CAS failure leaves "Waiting on you" stuck flagged forever.
        const persistWorkerResolve = (patch: Partial<ProjectManagedWorker>) =>
          Effect.gen(function* () {
            const saved = yield* repository
              .saveManagedWorkerMonitor({
                worker: { ...worker, ...patch, updatedAt: nowIso },
                expectedUpdatedAt: worker.updatedAt,
              })
              .pipe(Effect.catch(() => Effect.succeed({ applied: false as const })));
            if (saved.applied) return;
            const fresh = yield* repository
              .findManagedWorkerByThread(worker.threadId)
              .pipe(Effect.catch(() => Effect.succeed(Option.none())));
            if (Option.isNone(fresh)) return;
            yield* repository
              .saveManagedWorkerMonitor({
                worker: { ...fresh.value, ...patch, updatedAt: fresh.value.updatedAt },
                expectedUpdatedAt: fresh.value.updatedAt,
              })
              .pipe(Effect.catch(() => Effect.void));
          });
        if (input.action === "stop") {
          yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.makeUnsafe(`agent-resolve:${input.requestId}:stop`),
              threadId: worker.threadId,
              createdAt: nowIso,
            })
            .pipe(Effect.mapError(toServiceError("Failed to interrupt the worker thread.")));
          yield* persistWorkerResolve({ needsYou: false, needsYouAt: null });
          return { resolved: true };
        }
        // retry — re-dispatch the recorded task prompt as a queued turn.
        const prompt = worker.taskPrompt;
        if (prompt === null || prompt.trim().length === 0) {
          return yield* Effect.fail(
            fail("This worker has no recorded task prompt to retry.", "invalid"),
          );
        }
        const shell = yield* snapshotQuery
          .getThreadShellById(worker.threadId)
          .pipe(Effect.mapError(toServiceError("Failed to load worker thread.")));
        if (Option.isNone(shell)) {
          return yield* Effect.fail(fail("Worker thread was not found.", "not-found"));
        }
        const commandId = `agent-resolve:${input.requestId}:retry`;
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(commandId),
            threadId: worker.threadId,
            message: {
              messageId: MessageId.makeUnsafe(`${commandId}:message`),
              role: "user",
              text: prompt,
              attachments: [],
            },
            dispatchMode: "queue",
            dispatchOrigin: "user",
            runtimeMode: shell.value.runtimeMode,
            interactionMode: shell.value.interactionMode,
            createdAt: nowIso,
          })
          .pipe(Effect.mapError(toServiceError("Failed to re-dispatch the worker turn.")));
        // The retry belongs to the user — mark ownership so the health ladder
        // doesn't steer over it — and the worker is monitored again.
        yield* persistWorkerResolve({
          activeTurnOrigin: "user",
          activeTurnCommandId: commandId,
          needsYou: false,
          needsYouAt: null,
          settledAt: null,
          settleOutcome: null,
        });
        return { resolved: true };
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

    // thread.turn.start on a group's coordinator must refuse while the group
    // is paused or archived — client-side pickers filter, but the server is
    // the gate.
    assertGroupCoordinatorTurnAllowed: (input) =>
      Effect.gen(function* () {
        const config = yield* repository
          .getConfigByCoordinatorThread(input.threadId)
          .pipe(Effect.mapError(toServiceError("Failed to load group coordinator state.")));
        if (Option.isNone(config)) return;
        if (config.value.pausedAt !== null) {
          return yield* Effect.fail(
            fail("This group is paused — resume it before driving the coordinator.", "conflict"),
          );
        }
        if (config.value.archivedAt !== null) {
          return yield* Effect.fail(
            fail(
              "This group is archived — unarchive it before driving the coordinator.",
              "conflict",
            ),
          );
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
          yield* resolveGroupCoordinatorProject(input.projectId);
          const matchesProject = (event: ProjectAgentStreamEvent) => {
            if (event.type === "snapshot") return event.overview.projectId === input.projectId;
            if (event.type === "config-upserted") return event.config.projectId === input.projectId;
            if (event.type === "goal-upserted") return event.goal.projectId === input.projectId;
            if (event.type === "task-upserted") return event.task.projectId === input.projectId;
            if (event.type === "activity-appended")
              return event.activity.projectId === input.projectId;
            if (event.type === "digest-upserted") return event.digest.projectId === input.projectId;
            if (event.type === "thread-index-upserted") return event.projectId === input.projectId;
            return event.head.projectId === input.projectId;
          };
          const liveQueue = yield* Queue.bounded<ProjectAgentStreamEvent, Cause.Done>(64);
          // `Stream.fromPubSub` never delivers under this runtime — subscribe
          // explicitly in the stream's own scope and drain that subscription.
          const subscription = yield* PubSub.subscribe(events);
          yield* Stream.fromSubscription(subscription).pipe(
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
