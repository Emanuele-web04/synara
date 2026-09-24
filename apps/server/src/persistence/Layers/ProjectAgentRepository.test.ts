import {
  ProjectActivityId,
  ProjectGoalId,
  ProjectId,
  ProjectInboxEventId,
  ProjectTaskAttemptId,
  ProjectTaskId,
  ProjectDocumentRevisionId,
  ThreadId,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectAgentRepository } from "../Services/ProjectAgentRepository.ts";
import { ProjectAgentRepositoryLive } from "./ProjectAgentRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectAgentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const projectId = ProjectId.makeUnsafe("project-coord-1");
const coordinatorThreadId = ThreadId.makeUnsafe("thread-coordinator");
const now = "2026-09-15T12:00:00.000Z";
const limits = {
  maxConcurrentWorkers: 2,
  maxNewWorkersPerTurn: 4,
  maxWorkerCreationsPerGoal: 12,
  maxAutomaticContinuationsPerGoal: 20,
  maxRepairRoundsPerTask: 2,
};

layer("ProjectAgentRepository", (it) => {
  it.effect("CAS config writes reject stale revisions", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const config = {
        projectId,
        coordinatorThreadId,
        coordinatorName: "Demo Coordinator",
        coordinatorModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      };
      yield* repository.saveConfig(config, null);
      const stale = yield* Effect.exit(
        repository.saveConfig({ ...config, revision: 2, coordinatorName: "Stale" }, 0),
      );
      assert.equal(Exit.isFailure(stale), true);
      const loaded = yield* repository.getConfig(projectId);
      assert.equal(Option.isSome(loaded), true);
      if (Option.isSome(loaded)) {
        assert.equal(loaded.value.coordinatorName, "Demo Coordinator");
      }
    }),
  );

  it.effect("round-trips group goal, icon, and auto memory", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const config = {
        projectId,
        coordinatorThreadId,
        coordinatorName: "Demo Coordinator",
        coordinatorModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
        goal: "Ship groups",
        icon: "folder",
        autoMemoryEnabled: true,
        linkedProjectIds: [],
        libraryPath: "/tmp/library",
        libraryRemoteUrl: "https://example.com/library.git",
        libraryPushOnChange: true,
      };
      yield* repository.saveConfig(
        {
          ...config,
          projectId: ProjectId.makeUnsafe("project-coord-fields"),
          coordinatorThreadId: ThreadId.makeUnsafe("thread-coordinator-fields"),
        },
        null,
      );
      const loaded = yield* repository.getConfig(ProjectId.makeUnsafe("project-coord-fields"));
      assert.equal(Option.isSome(loaded), true);
      if (Option.isSome(loaded)) {
        assert.equal(loaded.value.goal, "Ship groups");
        assert.equal(loaded.value.icon, "folder");
        assert.equal(loaded.value.autoMemoryEnabled, true);
        assert.deepEqual(loaded.value.linkedProjectIds, []);
        assert.equal(loaded.value.libraryPath, "/tmp/library");
        assert.equal(loaded.value.libraryRemoteUrl, "https://example.com/library.git");
        assert.equal(loaded.value.libraryPushOnChange, true);
      }
    }),
  );

  it.effect("document writes require the expected revision", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const first = yield* repository.writeDocument({
        expectedRevision: null,
        revision: {
          id: ProjectDocumentRevisionId.makeUnsafe("rev-1"),
          projectId,
          logicalPath: "notes.md",
          revision: 1,
          content: "one",
          contentHash: "h1",
          authorKind: "user",
          authorThreadId: null,
          sources: [],
          createdAt: now,
        },
      });
      assert.equal(first.revision, 1);
      const conflict = yield* Effect.exit(
        repository.writeDocument({
          expectedRevision: 0,
          revision: {
            id: ProjectDocumentRevisionId.makeUnsafe("rev-2"),
            projectId,
            logicalPath: "notes.md",
            revision: 2,
            content: "two",
            contentHash: "h2",
            authorKind: "user",
            authorThreadId: null,
            sources: [],
            createdAt: now,
          },
        }),
      );
      assert.equal(Exit.isFailure(conflict), true);
    }),
  );

  it.effect("does not replay a receipt from another project", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      yield* repository.saveReceipt({
        requestId: "req-shared",
        projectId,
        operation: "configure",
        resultJson: JSON.stringify({ project: "coord-1" }),
        createdAt: now,
      });
      const own = yield* repository.getReceipt({ requestId: "req-shared", projectId });
      assert.equal(Option.isSome(own), true);
      const other = yield* repository.getReceipt({
        requestId: "req-shared",
        projectId: ProjectId.makeUnsafe("project-other"),
      });
      assert.equal(Option.isNone(other), true);
    }),
  );

  it.effect("stores attempts without implying task completion", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const goalId = ProjectGoalId.makeUnsafe("goal-1");
      const taskId = ProjectTaskId.makeUnsafe("task-1");
      yield* repository.saveGoal(
        {
          id: goalId,
          projectId,
          objective: "Ship coordinator",
          authorizationSource: "user",
          scopeVersion: 1,
          acceptanceCriteria: null,
          limits,
          status: "active",
          continuationCount: 0,
          workerCreationCount: 0,
          authorizedAt: now,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        null,
      );
      yield* repository.saveTask(
        {
          id: taskId,
          projectId,
          goalId,
          title: "Implement persistence",
          description: null,
          acceptanceCriteria: "Tables exist",
          status: "running",
          dependsOnTaskIds: [],
          assignedThreadId: ThreadId.makeUnsafe("thread-worker"),
          repairCount: 0,
          archivedAt: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        null,
      );
      yield* repository.saveAttempt({
        id: ProjectTaskAttemptId.makeUnsafe("attempt-1"),
        projectId,
        taskId,
        workerThreadId: ThreadId.makeUnsafe("thread-worker"),
        gatewayOperationId: null,
        requestId: "op-1",
        attemptNumber: 1,
        outcome: "succeeded",
        error: null,
        createdAt: now,
        finishedAt: now,
      });
      const task = yield* repository.getTask(taskId);
      assert.equal(Option.isSome(task), true);
      if (Option.isSome(task)) {
        assert.equal(task.value.status, "running");
      }
    }),
  );

  it.effect("lists lightweight summaries with the active goal status", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const firstProjectId = ProjectId.makeUnsafe("project-summary-1");
      const secondProjectId = ProjectId.makeUnsafe("project-summary-2");
      const firstThreadId = ThreadId.makeUnsafe("thread-summary-1");
      const secondThreadId = ThreadId.makeUnsafe("thread-summary-2");
      const config = {
        projectId: firstProjectId,
        coordinatorThreadId: firstThreadId,
        coordinatorName: "Demo Coordinator",
        coordinatorModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      };
      yield* repository.saveConfig(config, null);
      yield* repository.saveConfig(
        {
          ...config,
          projectId: secondProjectId,
          coordinatorThreadId: secondThreadId,
          coordinatorName: "Other Coordinator",
        },
        null,
      );
      yield* repository.saveGoal(
        {
          id: ProjectGoalId.makeUnsafe("goal-summary"),
          projectId: firstProjectId,
          objective: "Keep summaries fresh",
          authorizationSource: "user",
          scopeVersion: 1,
          acceptanceCriteria: null,
          limits,
          status: "active",
          continuationCount: 0,
          workerCreationCount: 0,
          authorizedAt: now,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        null,
      );
      const summaries = yield* repository.listSummaries();
      const byProject = new Map(summaries.map((row) => [row.projectId, row]));
      assert.equal(byProject.get(firstProjectId)?.coordinatorName, "Demo Coordinator");
      assert.equal(byProject.get(firstProjectId)?.goalStatus, "active");
      assert.equal(byProject.get(secondProjectId)?.coordinatorName, "Other Coordinator");
      assert.equal(byProject.get(secondProjectId)?.goalStatus, null);
    }),
  );

  it.effect("delivers every out-of-order inbox event exactly once across pages", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const inboxProjectId = ProjectId.makeUnsafe("project-inbox-order");
      const sourceThreadId = ThreadId.makeUnsafe("thread-inbox-source");
      // Random UUIDs deliberately out of order relative to created_at: a cursor
      // that keyed on inbox_id alone would skip or redeliver these rows.
      const rows = [
        { id: "zzzz-0000-0000-0000-000000000001", createdAt: "2026-09-15T12:00:00.000Z" },
        { id: "0000-0000-0000-0000-0000000000aa", createdAt: "2026-09-15T12:00:00.000Z" },
        { id: "ffff-0000-0000-0000-000000000002", createdAt: "2026-09-15T12:00:01.000Z" },
        { id: "1111-0000-0000-0000-0000000000bb", createdAt: "2026-09-15T12:00:01.000Z" },
        { id: "aaaa-0000-0000-0000-000000000003", createdAt: "2026-09-15T12:00:02.000Z" },
      ];
      for (const [index, row] of rows.entries()) {
        const { inserted } = yield* repository.insertInboxEvent({
          id: ProjectInboxEventId.makeUnsafe(row.id),
          projectId: inboxProjectId,
          sourceThreadId,
          sourceEventId: `source-${index}`,
          eventType: "thread.turn-diff-completed",
          taskId: null,
          eligibleWake: true,
          createdAt: row.createdAt,
        });
        assert.equal(inserted, true);
      }
      const delivered: string[] = [];
      let cursor: { createdAt: string | null; id: string | null } = {
        createdAt: null,
        id: null,
      };
      for (let page = 0; page < 10; page += 1) {
        const batch = yield* repository.listInboxAfter({
          projectId: inboxProjectId,
          afterCreatedAt: cursor.createdAt,
          afterId: cursor.id,
          limit: 2,
        });
        if (batch.length === 0) break;
        delivered.push(...batch.map((event) => event.id));
        const last = batch[batch.length - 1]!;
        cursor = { createdAt: last.createdAt, id: last.id };
      }
      assert.deepEqual(delivered.sort(), rows.map((row) => row.id).sort());
      // Re-inserting the same source_event_id dedupes to the stored row.
      const { inserted: deduped, event: dedupedEvent } = yield* repository.insertInboxEvent({
        id: ProjectInboxEventId.makeUnsafe("bbbb-0000-0000-0000-0000000000dd"),
        projectId: inboxProjectId,
        sourceThreadId,
        sourceEventId: "source-0",
        eventType: "thread.turn-diff-completed",
        taskId: null,
        eligibleWake: true,
        createdAt: "2026-09-15T12:00:03.000Z",
      });
      assert.equal(deduped, false);
      assert.equal(dedupedEvent.id, "bbbb-0000-0000-0000-0000000000dd");
    }),
  );

  it.effect("allocates activity sequences atomically across concurrent appends", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const activityProjectId = ProjectId.makeUnsafe("project-activity-seq");
      const activities = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => index),
        (index) =>
          repository.appendActivity({
            id: ProjectActivityId.makeUnsafe(`activity-${index}`),
            projectId: activityProjectId,
            kind: "task-updated",
            actorKind: "coordinator",
            actorThreadId: null,
            goalId: null,
            taskId: null,
            source: null,
            summary: `activity ${index}`,
            createdAt: `2026-09-15T12:00:${String(index).padStart(2, "0")}.000Z`,
          }),
        { concurrency: "unbounded" },
      );
      const sequences = activities.map((activity) => activity.sequence).sort((a, b) => a - b);
      assert.deepEqual(
        sequences,
        Array.from({ length: 8 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("pages activity strictly by sequence", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const activityProjectId = ProjectId.makeUnsafe("project-activity-page");
      for (const index of [0, 1, 2, 3, 4]) {
        yield* repository.appendActivity({
          id: ProjectActivityId.makeUnsafe(`activity-page-${index}`),
          projectId: activityProjectId,
          kind: "task-updated",
          actorKind: "coordinator",
          actorThreadId: null,
          goalId: null,
          taskId: null,
          source: null,
          summary: `page ${index}`,
          // Same created_at for every row: a (created_at, activity_id) cursor
          // on random UUIDs could skip rows; the sequence cursor cannot.
          createdAt: "2026-09-15T12:00:00.000Z",
        });
      }
      const first = yield* repository.listActivity({ projectId: activityProjectId, limit: 2 });
      assert.deepEqual(
        first.map((row) => row.sequence),
        [5, 4],
      );
      const second = yield* repository.listActivity({
        projectId: activityProjectId,
        limit: 2,
        cursor: { sequence: first[first.length - 1]!.sequence },
      });
      assert.deepEqual(
        second.map((row) => row.sequence),
        [3, 2],
      );
      const third = yield* repository.listActivity({
        projectId: activityProjectId,
        limit: 2,
        cursor: { sequence: second[second.length - 1]!.sequence },
      });
      assert.deepEqual(
        third.map((row) => row.sequence),
        [1],
      );
    }),
  );

  it.effect("round-trips wake cursors with the createdAt keyset and busy marker", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const cursorProjectId = ProjectId.makeUnsafe("project-cursor");
      const initial = yield* repository.getCursor(cursorProjectId);
      assert.equal(initial.processedThroughInboxId, null);
      assert.equal(initial.coordinatorBusy, false);
      yield* repository.saveCursor({
        projectId: cursorProjectId,
        processedThroughInboxId: "inbox-9",
        processedThroughCreatedAt: "2026-09-15T12:05:00.000Z",
        frozenFromInboxId: "inbox-9",
        frozenToInboxId: "inbox-12",
        coordinatorBusy: true,
        coordinatorBusySince: "2026-09-15T12:05:01.000Z",
        updatedAt: "2026-09-15T12:05:02.000Z",
      });
      const busy = yield* repository.getCursor(cursorProjectId);
      assert.equal(busy.processedThroughInboxId, "inbox-9");
      assert.equal(busy.processedThroughCreatedAt, "2026-09-15T12:05:00.000Z");
      assert.equal(busy.coordinatorBusy, true);
      assert.equal(busy.coordinatorBusySince, "2026-09-15T12:05:01.000Z");
      yield* repository.saveCursor({
        projectId: cursorProjectId,
        processedThroughInboxId: "inbox-12",
        processedThroughCreatedAt: "2026-09-15T12:06:00.000Z",
        frozenFromInboxId: null,
        frozenToInboxId: null,
        coordinatorBusy: false,
        coordinatorBusySince: null,
        updatedAt: "2026-09-15T12:06:01.000Z",
      });
      const cleared = yield* repository.getCursor(cursorProjectId);
      assert.equal(cleared.coordinatorBusy, false);
      assert.equal(cleared.coordinatorBusySince, null);
      assert.equal(cleared.frozenFromInboxId, null);
    }),
  );

  it.effect("marks interrupted digests failed on startup reset", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const digestProjectId = ProjectId.makeUnsafe("project-digest-reset");
      yield* repository.saveDigest({
        projectId: digestProjectId,
        summary: "old",
        focusItems: [],
        coverageFromSequence: 0,
        coverageToSequence: 3,
        historicalCoverage: "none",
        summarizedThreadCount: 0,
        pendingThreadCount: 2,
        generationState: "running",
        generatedAt: null,
        lastGoodAt: null,
        lastError: null,
      });
      const reset = yield* repository.resetInterruptedDigests();
      assert.equal(reset >= 1, true);
      const digest = yield* repository.getDigest(digestProjectId);
      assert.equal(Option.isSome(digest) && digest.value.generationState === "failed", true);
      // A second reset leaves the failed digest untouched.
      const again = yield* repository.resetInterruptedDigests();
      const digestAfter = yield* repository.getDigest(digestProjectId);
      assert.equal(
        Option.isSome(digestAfter) && digestAfter.value.generationState === "failed",
        true,
      );
      assert.equal(again >= 0, true);
    }),
  );

  it.effect("still loads a digest whose stored error is oversize raw CLI output", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const sql = yield* SqlClient.SqlClient;
      const digestProjectId = ProjectId.makeUnsafe("project-digest-oversize-error");
      yield* repository.saveDigest({
        projectId: digestProjectId,
        summary: "",
        focusItems: [],
        coverageFromSequence: 0,
        coverageToSequence: 0,
        historicalCoverage: "complete",
        summarizedThreadCount: 0,
        pendingThreadCount: 0,
        generationState: "failed",
        generatedAt: null,
        lastGoodAt: null,
        lastError: null,
      });
      // Rows written before the save-side cap existed can hold >2,000 chars
      // with ANSI escapes; loading them must not fail the whole overview.
      const raw = `Codex CLI command failed: \u001b[1mworkdir:\u001b[0m ${"x".repeat(2_500)}`;
      yield* sql`UPDATE project_agent_digests SET last_error = ${raw} WHERE project_id = ${digestProjectId}`;
      const digest = yield* repository.getDigest(digestProjectId);
      assert.equal(Option.isSome(digest), true);
      if (Option.isSome(digest)) {
        const lastError = digest.value.lastError ?? "";
        assert.equal(lastError.length <= 2_000, true);
        assert.equal(lastError.includes("\u001b"), false);
        assert.equal(lastError.startsWith("Codex CLI command failed: workdir:"), true);
      }
    }),
  );

  it.effect("tracks the disk-sync marker so external edits conflict once", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const docProjectId = ProjectId.makeUnsafe("project-doc-diskhash");
      const write = (diskHash: string | null, expectedRevision: number | null, n: number) =>
        repository.writeDocument({
          expectedRevision,
          diskHash,
          revision: {
            id: ProjectDocumentRevisionId.makeUnsafe(`rev-diskhash-${n}`),
            projectId: docProjectId,
            logicalPath: "notes.md",
            revision: n,
            content: `v${n}`,
            contentHash: `content-h${n}`,
            authorKind: "user",
            authorThreadId: null,
            sources: [],
            createdAt: now,
          },
        });
      yield* write("disk-1", null, 1);
      const head = yield* repository.getDocumentHead(docProjectId, "notes.md");
      assert.equal(Option.isSome(head) && head.value.diskHash === "disk-1", true);
      // The mirror write bumps the marker without inserting a revision.
      yield* repository.markDocumentDiskSynced({
        projectId: docProjectId,
        logicalPath: "notes.md",
        diskHash: "disk-1-mirrored",
      });
      const synced = yield* repository.getDocumentHead(docProjectId, "notes.md");
      assert.equal(Option.isSome(synced) && synced.value.diskHash === "disk-1-mirrored", true);
      // Stale expectedRevision still maps to a revision-mismatch failure.
      const conflict = yield* Effect.exit(write("disk-2", 0, 2));
      assert.equal(Exit.isFailure(conflict), true);
      if (Exit.isFailure(conflict)) {
        assert.equal(String(conflict.cause).includes("revision mismatch"), true);
      }
    }),
  );

  it.effect("finds the owning task for an assigned worker thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const ownerProjectId = ProjectId.makeUnsafe("project-assigned-owner");
      const goalId = ProjectGoalId.makeUnsafe("goal-assigned");
      const workerThreadId = ThreadId.makeUnsafe("thread-assigned-worker");
      yield* repository.saveConfig(
        {
          projectId: ownerProjectId,
          coordinatorThreadId: ThreadId.makeUnsafe("thread-assigned-coordinator"),
          coordinatorName: "Owner Coordinator",
          coordinatorModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
          limits,
          captureEnabled: true,
          enabled: true,
          automationId: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          disabledAt: null,
        },
        null,
      );
      yield* repository.saveGoal(
        {
          id: goalId,
          projectId: ownerProjectId,
          objective: "Track workers",
          authorizationSource: "user",
          scopeVersion: 1,
          acceptanceCriteria: null,
          limits,
          status: "active",
          continuationCount: 0,
          workerCreationCount: 0,
          authorizedAt: now,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        null,
      );
      const taskId = ProjectTaskId.makeUnsafe("task-assigned");
      yield* repository.saveTask(
        {
          id: taskId,
          projectId: ownerProjectId,
          goalId,
          title: "Assigned work",
          description: null,
          acceptanceCriteria: null,
          status: "running",
          dependsOnTaskIds: [],
          assignedThreadId: workerThreadId,
          repairCount: 0,
          archivedAt: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        null,
      );
      const found = yield* repository.findTaskByAssignedThread(workerThreadId);
      assert.equal(Option.isSome(found) && found.value.id === taskId, true);
      const missing = yield* repository.findTaskByAssignedThread(
        ThreadId.makeUnsafe("thread-unassigned"),
      );
      assert.equal(Option.isNone(missing), true);
    }),
  );
});
