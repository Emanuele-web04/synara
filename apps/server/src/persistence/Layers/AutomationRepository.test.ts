import { assert, it } from "@effect/vitest";
import {
  AutomationId,
  AutomationRunId,
  ProjectId,
  ThreadId,
  type AutomationCreateInput,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { runMigrations } from "../Migrations.ts";
import { AutomationRepositoryLive } from "./AutomationRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { AutomationRepository } from "../Services/AutomationRepository.ts";

const layer = it.layer(
  AutomationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const createInput = {
  name: "Nightly maintenance",
  projectId: ProjectId.makeUnsafe("project-1"),
  prompt: "Check stale dependencies.",
  schedule: { type: "manual" },
  modelSelection: {
    provider: "codex",
    model: "gpt-5-codex",
  },
} satisfies AutomationCreateInput;

const createInputForProject = (projectId: string) => ({
  ...createInput,
  projectId: ProjectId.makeUnsafe(projectId),
});

const permissionSnapshot = {
  provider: "codex",
  modelSelection: {
    provider: "codex",
    model: "gpt-5-codex",
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  worktreeMode: "worktree",
  allowedCapabilities: ["send-turn", "create-worktree"],
  createdAt: "2026-06-16T10:00:00.000Z",
} as const;

layer("AutomationRepository", (it) => {
  it.effect("creates and lists automation definitions with approval-required defaults", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      const created = yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-1"),
        input: createInputForProject("project-1"),
        now: "2026-06-16T10:00:00.000Z",
      });
      const listed = yield* repository.list({ includeArchived: false });

      assert.strictEqual(created.runtimeMode, "approval-required");
      assert.strictEqual(created.worktreeMode, "auto");
      assert.strictEqual(listed.definitions.length, 1);
      assert.strictEqual(listed.definitions[0]?.id, created.id);
    }),
  );

  it.effect("claims only expired scheduler leases", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      const firstClaim = yield* repository.tryAcquireSchedulerLease({
        leaseKey: "automation-scheduler",
        ownerId: "server-1",
        now: "2026-06-16T10:00:00.000Z",
        leaseExpiresAt: "2026-06-16T10:01:00.000Z",
      });
      const blockedClaim = yield* repository.tryAcquireSchedulerLease({
        leaseKey: "automation-scheduler",
        ownerId: "server-2",
        now: "2026-06-16T10:00:30.000Z",
        leaseExpiresAt: "2026-06-16T10:01:30.000Z",
      });
      const reclaimedClaim = yield* repository.tryAcquireSchedulerLease({
        leaseKey: "automation-scheduler",
        ownerId: "server-2",
        now: "2026-06-16T10:01:01.000Z",
        leaseExpiresAt: "2026-06-16T10:02:01.000Z",
      });

      assert.isTrue(firstClaim);
      assert.isFalse(blockedClaim);
      assert.isTrue(reclaimedClaim);
    }),
  );

  it.effect("dedupes scheduled runs by automation and scheduled time", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-2"),
        input: createInputForProject("project-2"),
        now: "2026-06-16T10:00:00.000Z",
      });
      const first = yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-1"),
        automationId: AutomationId.makeUnsafe("automation-2"),
        projectId: ProjectId.makeUnsafe("project-2"),
        threadId: null,
        trigger: { type: "scheduled" },
        scheduledFor: "2026-06-16T10:05:00.000Z",
        permissionSnapshot,
        now: "2026-06-16T10:00:00.000Z",
      });
      const second = yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-2"),
        automationId: AutomationId.makeUnsafe("automation-2"),
        projectId: ProjectId.makeUnsafe("project-2"),
        threadId: ThreadId.makeUnsafe("thread-2"),
        trigger: { type: "scheduled" },
        scheduledFor: "2026-06-16T10:05:00.000Z",
        permissionSnapshot,
        now: "2026-06-16T10:00:01.000Z",
      });

      assert.strictEqual(second.id, first.id);
      assert.isTrue(Option.isSome(yield* repository.getRunById({ id: first.id })));
    }),
  );
});
