import {
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ServerSettings,
  type UsageLimitRecovery,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";

import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { UsageLimitRecoveryReactor } from "../Services/UsageLimitRecoveryReactor.ts";
import { makeUsageLimitRecoveryReactorLive } from "./UsageLimitRecoveryReactor.ts";

afterEach(() => vi.restoreAllMocks());

const drain = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
});

function recovery(resetAt: string, id = "limit-episode"): UsageLimitRecovery {
  return {
    id,
    turnId: TurnId.makeUnsafe("limited-turn"),
    resetAt,
    autoResume: true,
    provider: "codex",
    providerInstanceId: "codex",
    model: "gpt-5-codex",
    bindingKey: "opaque-account-binding",
    policyEpoch: 0,
  };
}

function thread(wait: UsageLimitRecovery | null): OrchestrationThread {
  return {
    id: ThreadId.makeUnsafe("usage-limit-thread"),
    projectId: ProjectId.makeUnsafe("usage-limit-project"),
    title: "Limited task",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    interactionMode: "default",
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
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
    usageLimitRecovery: wait,
  };
}

const fixture = (
  initial: OrchestrationThread,
  settings: Partial<ServerSettings> = { autoResumeAfterUsageLimits: true },
) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    let model: OrchestrationReadModel = {
      snapshotSequence: 0,
      spaces: [],
      projects: [],
      threads: [initial],
      updatedAt: new Date().toISOString(),
    };
    const commands: OrchestrationCommand[] = [];
    let snapshotReads = 0;
    let blocked = false;
    let failStream = false;
    let deliveryBlocked = false;
    let deliveryReadFailed = false;
    const providerCommands = {
      listBlockingDeliveries: () =>
        deliveryReadFailed
          ? Effect.fail(new Error("Journal temporarily unavailable"))
          : Effect.succeed(deliveryBlocked ? [{ state: "uncertain" }] : []),
    } as unknown as ProviderCommandReactorShape;
    const updateRecovery = (wait: UsageLimitRecovery | null) =>
      Effect.gen(function* () {
        const event: OrchestrationEvent = {
          type: "thread.meta-updated",
          sequence: model.snapshotSequence + 1,
          eventId: EventId.makeUnsafe(`event-${model.snapshotSequence + 1}`),
          aggregateKind: "thread",
          aggregateId: initial.id,
          occurredAt: new Date().toISOString(),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId: initial.id,
            usageLimitRecovery: wait,
            updatedAt: new Date().toISOString(),
          },
        };
        model = {
          ...model,
          snapshotSequence: event.sequence,
          threads: [{ ...model.threads[0]!, usageLimitRecovery: wait }],
        };
        yield* PubSub.publish(events, event);
      });
    const dispatch = (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        commands.push(command);
        if (command.type === "thread.usage-limit.resume" && blocked) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Pending user decision still owns the task.",
            }),
          );
        }
        if (
          (command.type === "thread.usage-limit.resume" ||
            command.type === "thread.usage-limit.cancel") &&
          command.recoveryId === model.threads[0]?.usageLimitRecovery?.id
        ) {
          yield* updateRecovery(null);
        }
        return { sequence: model.snapshotSequence };
      });
    const engine = {
      dispatch,
      getReadModel: () => Effect.sync(() => model),
      subscribeDomainEvents: Effect.map(PubSub.subscribe(events), (subscription) =>
        Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
          Stream.tap(() => {
            if (!failStream) return Effect.void;
            failStream = false;
            return Effect.die("lost domain event consumer");
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
    const layer = makeUsageLimitRecoveryReactorLive().pipe(
      Layer.provide(Layer.succeed(ProviderCommandReactor, providerCommands)),
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, query)),
      Layer.provideMerge(ServerSettingsService.layerTest(settings)),
    );
    return {
      layer,
      commands,
      updateRecovery,
      read: () => model.threads[0]!,
      snapshotReads: () => snapshotReads,
      setDeliveryBlocked: (value: boolean) => {
        deliveryBlocked = value;
      },
      setDeliveryReadFailed: (value: boolean) => {
        deliveryReadFailed = value;
      },
      setBlocked: (value: boolean) => {
        blocked = value;
      },
      failStream: () => {
        failStream = true;
      },
    };
  });

it.effect("restores an overdue wait and requests one continuation through command dispatch", () =>
  Effect.gen(function* () {
    const wait = recovery(new Date(Date.now() - 1_000).toISOString());
    const state = yield* fixture(thread(wait));
    yield* Effect.gen(function* () {
      yield* (yield* UsageLimitRecoveryReactor).start();
      yield* drain;
      yield* TestClock.adjust("10 seconds");
      yield* drain;
      const resume = state.commands.filter(
        (command) => command.type === "thread.usage-limit.resume",
      );
      assert.strictEqual(resume.length, 1);
      assert.strictEqual(resume[0]?.recoveryId, wait.id);
      assert.strictEqual(resume[0]?.policyEpoch, 0);
      assert.isNull(state.read().usageLimitRecovery);
      assert.isNull(state.read().session);
      assert.strictEqual(state.read().messages.length, 0);
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);

it.effect("uses replacement deadlines and never dispatches a cancelled wait", () =>
  Effect.gen(function* () {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const state = yield* fixture(thread(recovery(new Date(now + 3_600_000).toISOString())));
    yield* Effect.gen(function* () {
      yield* (yield* UsageLimitRecoveryReactor).start();
      yield* drain;
      yield* state.updateRecovery(recovery(new Date(now + 1_000).toISOString(), "replacement"));
      yield* drain;
      yield* state.updateRecovery(null);
      yield* drain;
      now += 3_600_000;
      yield* TestClock.adjust("60 seconds");
      yield* drain;
      assert.strictEqual(state.commands.length, 0);
      assert.strictEqual(state.snapshotReads(), 1);
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);

it.effect("rechecks wall time after suspension and retries temporary admission blockers", () =>
  Effect.gen(function* () {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const state = yield* fixture(thread(recovery(new Date(now + 3_600_000).toISOString())));
    state.setBlocked(true);
    yield* Effect.gen(function* () {
      yield* (yield* UsageLimitRecoveryReactor).start();
      yield* drain;
      now += 7_200_000;
      yield* TestClock.adjust("60 seconds");
      yield* drain;
      assert.strictEqual(state.commands.length, 1);
      assert.isNotNull(state.read().usageLimitRecovery);
      state.setBlocked(false);
      yield* TestClock.adjust("5 seconds");
      yield* drain;
      assert.strictEqual(state.commands.length, 2);
      assert.notStrictEqual(state.commands[0]?.commandId, state.commands[1]?.commandId);
      assert.isNull(state.read().usageLimitRecovery);
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);

it.effect("cancels pending waits while disabled rather than resuming them", () =>
  Effect.gen(function* () {
    const state = yield* fixture(thread(recovery(new Date(Date.now() - 1_000).toISOString())), {
      autoResumeAfterUsageLimits: false,
    });
    yield* Effect.gen(function* () {
      yield* (yield* UsageLimitRecoveryReactor).start();
      yield* drain;
      assert.deepStrictEqual(
        state.commands.map((command) => command.type),
        ["thread.usage-limit.cancel"],
      );
      assert.isNull(state.read().usageLimitRecovery);
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);

it.effect("an off/on settings toggle cancels the previous policy epoch before its deadline", () =>
  Effect.gen(function* () {
    const state = yield* fixture(thread(recovery(new Date(Date.now() + 3_600_000).toISOString())));
    yield* Effect.gen(function* () {
      yield* (yield* UsageLimitRecoveryReactor).start();
      const settings = yield* ServerSettingsService;
      yield* drain;
      yield* settings.updateSettings({ autoResumeAfterUsageLimits: false });
      yield* settings.updateSettings({ autoResumeAfterUsageLimits: true });
      yield* drain;
      assert.isNull(state.read().usageLimitRecovery);
      assert.strictEqual(state.commands[0]?.type, "thread.usage-limit.cancel");
      assert.strictEqual(
        state.commands.some((command) => command.type === "thread.usage-limit.resume"),
        false,
      );
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);

it.effect("restores waits when its live event consumer fails and stops on scope closure", () =>
  Effect.gen(function* () {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const state = yield* fixture(thread(recovery(new Date(now + 3_600_000).toISOString())));
    yield* Effect.gen(function* () {
      yield* (yield* UsageLimitRecoveryReactor).start();
      yield* drain;
      state.failStream();
      yield* state.updateRecovery(recovery(new Date(now - 1_000).toISOString(), "restored"));
      yield* drain;
      yield* TestClock.adjust("5 seconds");
      yield* drain;
      assert.isNull(state.read().usageLimitRecovery);
      assert.strictEqual(state.snapshotReads(), 2);
      yield* state.updateRecovery(recovery(new Date(now + 1_000).toISOString(), "closed"));
      yield* drain;
    }).pipe(Effect.provide(state.layer), Effect.scoped);
    now += 60_000;
    yield* TestClock.adjust("60 seconds");
    assert.strictEqual(state.read().usageLimitRecovery?.id, "closed");
  }),
);

it.effect("a recovered wait from a disabled policy epoch stays cancelled after re-enable", () =>
  Effect.gen(function* () {
    const state = yield* fixture(thread(recovery(new Date(Date.now() - 1_000).toISOString())));
    yield* Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({ autoResumeAfterUsageLimits: false });
      yield* settings.updateSettings({ autoResumeAfterUsageLimits: true });
      yield* (yield* UsageLimitRecoveryReactor).start();
      yield* drain;
      assert.deepStrictEqual(
        state.commands.map((command) => command.type),
        ["thread.usage-limit.cancel"],
      );
      assert.isNull(state.read().usageLimitRecovery);
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);

it.effect(
  "does not schedule archived, deleted, or already resuming tasks from a restored snapshot",
  () =>
    Effect.gen(function* () {
      const past = new Date(Date.now() - 1_000).toISOString();
      for (const patch of [
        { archivedAt: past },
        { deletedAt: past },
        { usageLimitRecovery: { ...recovery(past), state: "resuming" as const } },
      ]) {
        const state = yield* fixture({ ...thread(recovery(past)), ...patch });
        yield* Effect.gen(function* () {
          yield* (yield* UsageLimitRecoveryReactor).start();
          yield* drain;
          yield* TestClock.adjust("60 seconds");
          yield* drain;
          assert.strictEqual(state.commands.length, 0);
        }).pipe(Effect.provide(state.layer), Effect.scoped);
      }
    }),
);

it.effect(
  "leaves an overdue wait unconsumed while provider delivery is uncertain or unreadable",
  () =>
    Effect.gen(function* () {
      const wait = recovery(new Date(Date.now() - 1_000).toISOString());
      const state = yield* fixture(thread(wait));
      state.setDeliveryBlocked(true);
      yield* Effect.gen(function* () {
        yield* (yield* UsageLimitRecoveryReactor).start();
        yield* drain;
        assert.strictEqual(state.commands.length, 0);
        assert.strictEqual(state.read().usageLimitRecovery?.id, wait.id);
        state.setDeliveryBlocked(false);
        state.setDeliveryReadFailed(true);
        yield* TestClock.adjust("5 seconds");
        yield* drain;
        assert.strictEqual(state.commands.length, 0);
        state.setDeliveryReadFailed(false);
        yield* TestClock.adjust("5 seconds");
        yield* drain;
        assert.strictEqual(
          state.commands.filter((command) => command.type === "thread.usage-limit.resume").length,
          1,
        );
      }).pipe(Effect.provide(state.layer), Effect.scoped);
    }),
);
