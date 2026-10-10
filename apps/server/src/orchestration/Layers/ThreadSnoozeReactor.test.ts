import {
  CommandId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";

import { decideOrchestrationCommand } from "../decider.ts";
import { projectEvent } from "../projector.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadSnoozeReactor } from "../Services/ThreadSnoozeReactor.ts";
import { makeThreadSnoozeReactorLive } from "./ThreadSnoozeReactor.ts";

afterEach(() => vi.restoreAllMocks());

const drain = Effect.gen(function* () {
  for (let i = 0; i < 30; i++) yield* Effect.yieldNow;
});

function thread(patch: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.makeUnsafe("reactor-snooze-thread"),
    projectId: ProjectId.makeUnsafe("reactor-snooze-project"),
    title: "Snooze",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    interactionMode: "default",
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    sidechatSourceThreadId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    latestTurn: null,
    handoff: null,
    messages: [],
    session: null,
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    deletedAt: null,
    ...patch,
  };
}

const fixture = (initialThread: OrchestrationThread) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    let model: OrchestrationReadModel = {
      snapshotSequence: 0,
      spaces: [],
      projects: [],
      threads: [initialThread],
      updatedAt: new Date().toISOString(),
    };
    let failureCount = 0;
    let snapshotReads = 0;
    let failStream = false;
    const dispatch = (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        if (
          command.type === "thread.meta.update" &&
          command.expectedSnoozedUntil !== undefined &&
          failureCount > 0
        ) {
          failureCount--;
          return yield* Effect.die("transient write failure");
        }
        const decided = yield* decideOrchestrationCommand({ readModel: model, command });
        for (const event of Array.isArray(decided) ? decided : [decided]) {
          const committed: OrchestrationEvent = { ...event, sequence: model.snapshotSequence + 1 };
          model = yield* projectEvent(model, committed);
          yield* PubSub.publish(events, committed);
        }
        return { sequence: model.snapshotSequence };
      });
    const engine = {
      dispatch,
      subscribeDomainEvents: Effect.map(PubSub.subscribe(events), (subscription) =>
        Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
          Stream.tap(() => {
            if (!failStream) return Effect.void;
            failStream = false;
            return Effect.die("transient event replay failure");
          }),
        ),
      ),
    } as unknown as OrchestrationEngineShape;
    const query = {
      getShellSnapshot: () =>
        Effect.sync(() => {
          snapshotReads++;
          return { ...model, threads: model.threads.filter((item) => item.deletedAt == null) };
        }),
    } as unknown as ProjectionSnapshotQueryShape;
    const layer = makeThreadSnoozeReactorLive().pipe(
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, query)),
    );
    return {
      layer,
      dispatch,
      read: () => model.threads[0]!,
      snapshotReads: () => snapshotReads,
      failStream: () => {
        failStream = true;
      },
      failNext: () => {
        failureCount = 1;
      },
    };
  });

it.effect("restores an overdue deadline on startup without starting provider work", () =>
  Effect.gen(function* () {
    const overdue = new Date(Date.now() - 1_000).toISOString();
    const state = yield* fixture(thread({ snoozedUntil: overdue, settledAt: overdue }));
    yield* Effect.gen(function* () {
      yield* (yield* ThreadSnoozeReactor).start();
      yield* drain;
      assert.isNull(state.read().snoozedUntil);
      assert.isString(state.read().snoozeReminderAt);
      assert.isNull(state.read().settledAt);
      assert.isNull(state.read().session);
      assert.strictEqual(state.read().messages.length, 0);
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);

it.effect("recomputes the nearest deadline after rescheduling and cancellation", () =>
  Effect.gen(function* () {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const state = yield* fixture(thread({ snoozedUntil: new Date(now + 3_600_000).toISOString() }));
    yield* Effect.gen(function* () {
      yield* (yield* ThreadSnoozeReactor).start();
      yield* drain;
      yield* state.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("nearer-deadline"),
        threadId: state.read().id,
        snoozedUntil: new Date(now + 1_000).toISOString(),
      });
      yield* drain;
      now += 1_000;
      yield* TestClock.adjust("1 second");
      yield* drain;
      assert.isNull(state.read().snoozedUntil);
      assert.isString(state.read().snoozeReminderAt);
      yield* state.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cancel-reminder"),
        threadId: state.read().id,
        snoozedUntil: null,
      });
      now += 60_000;
      yield* TestClock.adjust("60 seconds");
      yield* drain;
      assert.isNull(state.read().snoozeReminderAt);
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);

it.effect("rechecks wall-clock deadlines after suspension and retries a failed expiry", () =>
  Effect.gen(function* () {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const state = yield* fixture(thread({ snoozedUntil: new Date(now + 3_600_000).toISOString() }));
    yield* Effect.gen(function* () {
      yield* (yield* ThreadSnoozeReactor).start();
      yield* drain;
      state.failNext();
      now += 7_200_000;
      yield* TestClock.adjust("60 seconds");
      yield* drain;
      assert.isString(state.read().snoozedUntil);
      yield* TestClock.adjust("5 seconds");
      yield* drain;
      assert.isNull(state.read().snoozedUntil);
      assert.isString(state.read().snoozeReminderAt);
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);

it.effect("never wakes archived or deleted threads from an old snapshot", () =>
  Effect.gen(function* () {
    const past = new Date(Date.now() - 1_000).toISOString();
    for (const patch of [{ archivedAt: past }, { deletedAt: past }]) {
      const state = yield* fixture(thread({ snoozedUntil: past, ...patch }));
      yield* Effect.gen(function* () {
        yield* (yield* ThreadSnoozeReactor).start();
        yield* drain;
        assert.strictEqual(state.read().snoozedUntil, past);
        assert.isUndefined(state.read().snoozeReminderAt);
      }).pipe(Effect.provide(state.layer), Effect.scoped);
    }
  }),
);

it.effect("disposes its scheduled work when its server scope closes", () =>
  Effect.gen(function* () {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const future = new Date(now + 1_000).toISOString();
    const state = yield* fixture(thread({ snoozedUntil: future }));
    yield* Effect.gen(function* () {
      yield* (yield* ThreadSnoozeReactor).start();
      yield* drain;
    }).pipe(Effect.provide(state.layer), Effect.scoped);
    now += 60_000;
    yield* TestClock.adjust("60 seconds");
    assert.strictEqual(state.read().snoozedUntil, future);
  }),
);

it.effect("reads the workspace snapshot once while periodically rechecking deadlines", () =>
  Effect.gen(function* () {
    const state = yield* fixture(
      thread({ snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    yield* Effect.gen(function* () {
      yield* (yield* ThreadSnoozeReactor).start();
      yield* drain;
      yield* TestClock.adjust("60 seconds");
      yield* drain;
      yield* TestClock.adjust("60 seconds");
      yield* drain;
      assert.strictEqual(state.snapshotReads(), 1);
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);

it.effect("restores durable deadlines after its live event consumer fails", () =>
  Effect.gen(function* () {
    const state = yield* fixture(
      thread({ snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    yield* Effect.gen(function* () {
      yield* (yield* ThreadSnoozeReactor).start();
      yield* drain;
      state.failStream();
      yield* state.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("event-stream-failure"),
        threadId: state.read().id,
        snoozedUntil: new Date(Date.now() - 1_000).toISOString(),
      });
      yield* drain;
      yield* TestClock.adjust("5 seconds");
      yield* drain;
      assert.isNull(state.read().snoozedUntil);
      assert.isString(state.read().snoozeReminderAt);
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);
