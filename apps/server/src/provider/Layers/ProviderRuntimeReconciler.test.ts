import {
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type ProviderSession,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../../orchestration/Services/OrchestrationReactor.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeEventRepository,
  type ProviderRuntimeEventRepositoryShape,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ProviderRuntimeReconciler } from "../Services/ProviderRuntimeReconciler.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import { makeProviderRuntimeReconcilerLive } from "./ProviderRuntimeReconciler.ts";
import { fakeProjectionSnapshotQuery } from "../../orchestration/testing/fakeProjectionSnapshotQuery.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-runtime-reconciler");
const TURN_ID = TurnId.makeUnsafe("turn-runtime-reconciler");

function staleShellSnapshot(): OrchestrationShellSnapshot {
  const updatedAt = "2026-07-23T19:00:00.000Z";
  return {
    snapshotSequence: 1,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-runtime-reconciler"),
        runtimeMode: "full-access",
        updatedAt,
        latestTurn: {
          turnId: TURN_ID,
          state: "running",
          requestedAt: updatedAt,
          startedAt: updatedAt,
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt,
        },
      },
    ],
    updatedAt,
  } as unknown as OrchestrationShellSnapshot;
}

function readyProviderSession(): ProviderSession {
  return {
    provider: "codex",
    status: "ready",
    runtimeMode: "full-access",
    threadId: THREAD_ID,
    createdAt: "2026-07-23T19:00:00.000Z",
    updatedAt: "2026-07-23T20:00:00.000Z",
  };
}

function staleStartingShellSnapshot(): OrchestrationShellSnapshot {
  const snapshot = staleShellSnapshot();
  const thread = snapshot.threads[0]!;
  return {
    ...snapshot,
    threads: [
      {
        ...thread,
        latestTurn: {
          ...thread.latestTurn!,
          state: "completed",
          completedAt: thread.updatedAt,
        },
        session: {
          ...thread.session!,
          status: "starting",
          activeTurnId: null,
        },
      },
    ],
  };
}

function makePagingLayer(input: {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly commands: OrchestrationCommand[];
  readonly liveSessions: ReadonlyArray<ProviderSession>;
  readonly firstPageIds: ReadonlyArray<ThreadId>;
  readonly page: ProjectionSnapshotQueryShape["listStaleInFlightThreadPage"];
}) {
  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        input.commands.push(command);
        return { sequence: input.commands.length };
      }),
  } as unknown as OrchestrationEngineShape;
  const reactor = {
    start: Effect.void,
    reconcileSettledOpenTurns: Effect.void,
  } satisfies OrchestrationReactorShape;
  const query = fakeProjectionSnapshotQuery({
    // Keep the old API functional in the Before control: it repeatedly sees
    // healthy owners instead of failing because the new method is absent.
    listStaleInFlightThreadIds: () => Effect.succeed(input.firstPageIds),
    listStaleInFlightThreadPage: input.page,
    getThreadShellsByIds: (threadIds, options) =>
      Effect.sync(() => {
        expect(options).toEqual({ includeLatestMessageActivity: true });
        return input.snapshot.threads.filter((thread) => threadIds.includes(thread.id));
      }),
  });
  const directory = {
    listBindings: () =>
      Effect.succeed(
        input.snapshot.threads.map((thread) => {
          const live = input.liveSessions.find((session) => session.threadId === thread.id);
          return {
            threadId: thread.id,
            provider: "codex" as const,
            providerInstanceId: "codex",
            status: live?.activeTurnId === undefined ? "stopped" : "running",
            lastSeenAt: thread.updatedAt,
            runtimePayload: { activeTurnId: live?.activeTurnId ?? null },
          };
        }),
      ),
    upsert: () => Effect.die("paging must not rewrite healthy runtime bindings"),
  } as unknown as ProviderSessionDirectoryShape;
  const provider = {
    listSessions: () => Effect.succeed(input.liveSessions),
    getRuntimeEventPumpHealth: () => Effect.succeed([]),
  } as unknown as ProviderServiceShape;
  const runtimeEvents = {
    hasPendingEventsForThreads: () => Effect.succeed(false),
  } as unknown as ProviderRuntimeEventRepositoryShape;
  return makeProviderRuntimeReconcilerLive({
    now: () => Date.parse("2026-07-23T20:00:00.000Z"),
    staleAfterMs: 1,
    candidateLimit: 2,
  }).pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(OrchestrationReactor, reactor)),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, query)),
    Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
    Layer.provide(Layer.succeed(ProviderService, provider)),
    Layer.provide(Layer.succeed(ProviderRuntimeEventRepository, runtimeEvents)),
  );
}

describe("ProviderRuntimeReconcilerLive", () => {
  it("reaches abandoned work behind a full page of healthy live owners", async () => {
    const commands: OrchestrationCommand[] = [];
    const snapshot = staleShellSnapshot();
    const base = snapshot.threads[0]!;
    const owned = (name: string): OrchestrationThreadShell => {
      const threadId = ThreadId.makeUnsafe(name);
      const turnId = TurnId.makeUnsafe(`${name}-turn`);
      return {
        ...base,
        id: threadId,
        latestTurn: { ...base.latestTurn!, turnId },
        session: { ...base.session!, threadId, status: "running", activeTurnId: turnId },
      };
    };
    const first = owned("healthy-a");
    const second = owned("healthy-b");
    const abandoned = {
      ...base,
      id: ThreadId.makeUnsafe("later-abandoned"),
      session: { ...base.session!, threadId: ThreadId.makeUnsafe("later-abandoned") },
    };
    const calls: Parameters<ProjectionSnapshotQueryShape["listStaleInFlightThreadPage"]>[0][] = [];
    const firstCursor = { observedAt: base.updatedAt, threadId: second.id };
    const layer = makePagingLayer({
      snapshot: { ...snapshot, threads: [first, second, abandoned] },
      commands,
      firstPageIds: [first.id, second.id],
      liveSessions: [
        ...[first, second].map(
          (thread): ProviderSession => ({
            ...readyProviderSession(),
            threadId: thread.id,
            status: "running",
            activeTurnId: thread.latestTurn!.turnId,
          }),
        ),
        { ...readyProviderSession(), threadId: abandoned.id },
      ],
      page: (input) =>
        Effect.sync(() => {
          calls.push(input);
          if (input.after === undefined) {
            return { threadIds: [first.id, second.id], nextCursor: firstCursor };
          }
          expect(input.after).toEqual(firstCursor);
          return {
            threadIds: [abandoned.id],
            nextCursor: { observedAt: base.updatedAt, threadId: abandoned.id },
          };
        }),
    });

    await Effect.gen(function* () {
      const reconciler = yield* ProviderRuntimeReconciler;
      yield* reconciler.reconcileNow;
      expect(commands).toEqual([]);
      yield* reconciler.reconcileNow;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(
      commands.map((command) => [command.type, "threadId" in command ? command.threadId : null]),
    ).toEqual([
      ["thread.session.set", abandoned.id],
      ["thread.activity.append", abandoned.id],
    ]);
    const sessionCommand = commands[0];
    expect(sessionCommand?.type).toBe("thread.session.set");
    if (sessionCommand?.type === "thread.session.set") {
      expect(sessionCommand.session).toMatchObject({ status: "ready", activeTurnId: null });
    }
    const common = { updatedBefore: "2026-07-23T19:59:59.999Z", limit: 2 };
    expect(calls).toEqual([common, { ...common, after: firstCursor }]);
  });

  it("wraps once at the page boundary and clears the cursor when no candidates remain", async () => {
    const commands: OrchestrationCommand[] = [];
    const snapshot = staleShellSnapshot();
    const base = snapshot.threads[0]!;
    const thread = {
      ...base,
      session: { ...base.session!, status: "running" as const, activeTurnId: TURN_ID },
    };
    const cursor = { observedAt: base.updatedAt, threadId: THREAD_ID };
    const calls: Parameters<ProjectionSnapshotQueryShape["listStaleInFlightThreadPage"]>[0][] = [];
    const layer = makePagingLayer({
      snapshot: { ...snapshot, threads: [thread] },
      commands,
      firstPageIds: [THREAD_ID],
      liveSessions: [{ ...readyProviderSession(), status: "running", activeTurnId: TURN_ID }],
      page: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return calls.length === 1
            ? { threadIds: [THREAD_ID], nextCursor: cursor }
            : { threadIds: [], nextCursor: null };
        }),
    });

    await Effect.gen(function* () {
      const reconciler = yield* ProviderRuntimeReconciler;
      yield* reconciler.reconcileNow;
      yield* reconciler.reconcileNow;
      yield* reconciler.reconcileNow;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(commands).toEqual([]);
    const common = { updatedBefore: "2026-07-23T19:59:59.999Z", limit: 2 };
    expect(calls).toEqual([common, { ...common, after: cursor }, common, common]);
  });

  it("settles an abandoned starting session that has no active turn", async () => {
    const commands: OrchestrationCommand[] = [];
    const snapshot = staleStartingShellSnapshot();
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineShape;
    const reactor = {
      start: Effect.void,
      reconcileSettledOpenTurns: Effect.void,
    } satisfies OrchestrationReactorShape;
    const snapshotQuery = {
      listStaleInFlightThreadIds: () => Effect.succeed([THREAD_ID]),
      listStaleInFlightThreadPage: () =>
        Effect.succeed({
          threadIds: [THREAD_ID],
          nextCursor: { observedAt: "2026-07-23T19:00:00.000Z", threadId: THREAD_ID },
        }),
      getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
      getThreadShellsByIds: (threadIds: ReadonlyArray<ThreadId>, options: unknown) =>
        Effect.sync(() => {
          expect(threadIds).toEqual([THREAD_ID]);
          expect(options).toEqual({ includeLatestMessageActivity: true });
          return [snapshot.threads[0]!];
        }),
      getShellSnapshot: () => Effect.die("full shell snapshot should not be loaded"),
    } as unknown as ProjectionSnapshotQueryShape;
    const directory = {
      listBindings: () =>
        Effect.succeed([
          {
            threadId: THREAD_ID,
            provider: "codex" as const,
            providerInstanceId: "codex" as const,
            status: "starting" as const,
            runtimePayload: { activeTurnId: null },
          },
        ]),
    } as unknown as ProviderSessionDirectoryShape;
    const provider = {
      listSessions: () => Effect.succeed([]),
      getRuntimeEventPumpHealth: () => Effect.succeed([]),
    } as unknown as ProviderServiceShape;
    const runtimeEvents = {
      hasPendingEventsForThreads: () => Effect.succeed(false),
    } as unknown as ProviderRuntimeEventRepositoryShape;

    const layer = makeProviderRuntimeReconcilerLive({ staleAfterMs: 1 }).pipe(
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(Layer.succeed(OrchestrationReactor, reactor)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
      Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
      Layer.provide(Layer.succeed(ProviderService, provider)),
      Layer.provide(Layer.succeed(ProviderRuntimeEventRepository, runtimeEvents)),
    );

    await Effect.gen(function* () {
      const reconciler = yield* ProviderRuntimeReconciler;
      yield* reconciler.reconcileNow;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(commands.map((command) => command.type)).toEqual([
      "thread.session.set",
      "thread.activity.append",
    ]);
    const sessionCommand = commands[0];
    expect(sessionCommand?.type).toBe("thread.session.set");
    if (sessionCommand?.type === "thread.session.set") {
      expect(sessionCommand.session).toMatchObject({
        status: "interrupted",
        activeTurnId: null,
      });
    }
  });

  it("settles a start stranded without a turn on the stalled-start clock", async () => {
    const commands: OrchestrationCommand[] = [];
    const snapshot = staleStartingShellSnapshot();
    const stalledAt = new Date(Date.now() - 60_000).toISOString();
    const thread = {
      ...snapshot.threads[0]!,
      updatedAt: stalledAt,
      latestTurn: {
        ...snapshot.threads[0]!.latestTurn!,
        completedAt: stalledAt,
      },
      session: {
        ...snapshot.threads[0]!.session!,
        updatedAt: stalledAt,
      },
    };
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineShape;
    const reactor = {
      start: Effect.void,
      reconcileSettledOpenTurns: Effect.void,
    } satisfies OrchestrationReactorShape;
    const snapshotQuery = {
      listStaleInFlightThreadIds: () => Effect.succeed([THREAD_ID]),
      listStaleInFlightThreadPage: () =>
        Effect.succeed({
          threadIds: [THREAD_ID],
          nextCursor: { observedAt: "2026-07-23T19:00:00.000Z", threadId: THREAD_ID },
        }),
      getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
      getThreadShellsByIds: (threadIds: ReadonlyArray<ThreadId>, options: unknown) =>
        Effect.sync(() => {
          expect(threadIds).toEqual([THREAD_ID]);
          expect(options).toEqual({ includeLatestMessageActivity: true });
          return [thread];
        }),
      getShellSnapshot: () => Effect.die("full shell snapshot should not be loaded"),
    } as unknown as ProjectionSnapshotQueryShape;
    const directory = {
      listBindings: () =>
        Effect.succeed([
          {
            threadId: THREAD_ID,
            provider: "codex" as const,
            providerInstanceId: "codex" as const,
            status: "starting" as const,
            runtimePayload: { activeTurnId: null },
          },
        ]),
    } as unknown as ProviderSessionDirectoryShape;
    const provider = {
      listSessions: () => Effect.succeed([]),
      getRuntimeEventPumpHealth: () => Effect.succeed([]),
    } as unknown as ProviderServiceShape;
    const runtimeEvents = {
      hasPendingEventsForThreads: () => Effect.succeed(false),
    } as unknown as ProviderRuntimeEventRepositoryShape;

    // The start is only a minute old: far short of the 45-minute turn-age
    // budget, so this can only settle through the injected stalled-start clock.
    const layer = makeProviderRuntimeReconcilerLive({
      staleAfterMs: 1,
      maxStalledStartAgeMs: 30_000,
    }).pipe(
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(Layer.succeed(OrchestrationReactor, reactor)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
      Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
      Layer.provide(Layer.succeed(ProviderService, provider)),
      Layer.provide(Layer.succeed(ProviderRuntimeEventRepository, runtimeEvents)),
    );

    await Effect.gen(function* () {
      const reconciler = yield* ProviderRuntimeReconciler;
      yield* reconciler.reconcileNow;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(commands.map((command) => command.type)).toEqual([
      "thread.session.set",
      "thread.activity.append",
    ]);
    const sessionCommand = commands[0];
    expect(sessionCommand?.type).toBe("thread.session.set");
    if (sessionCommand?.type === "thread.session.set") {
      expect(sessionCommand.session).toMatchObject({
        status: "interrupted",
        activeTurnId: null,
      });
    }
  });

  it("keeps one activity identity while a stale-turn repair is retried and refined", async () => {
    const commands: OrchestrationCommand[] = [];
    const reconcileSettledOpenTurns = vi.fn();
    let bindingStatus: "stopped" | "error" = "stopped";
    let providerSession = readyProviderSession();

    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineShape;
    const reactor = {
      start: Effect.void,
      reconcileSettledOpenTurns: Effect.sync(reconcileSettledOpenTurns),
    } satisfies OrchestrationReactorShape;
    const snapshotQuery = {
      listStaleInFlightThreadIds: () => Effect.succeed([THREAD_ID]),
      listStaleInFlightThreadPage: () =>
        Effect.succeed({
          threadIds: [THREAD_ID],
          nextCursor: { observedAt: "2026-07-23T19:00:00.000Z", threadId: THREAD_ID },
        }),
      getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
      getThreadShellById: () => Effect.succeed(Option.some(staleShellSnapshot().threads[0]!)),
      getThreadShellsByIds: () => Effect.succeed([staleShellSnapshot().threads[0]!]),
      getShellSnapshot: () => Effect.die("full shell snapshot should not be loaded"),
    } as unknown as ProjectionSnapshotQueryShape;
    const directory = {
      listBindings: () =>
        Effect.succeed([
          {
            threadId: THREAD_ID,
            provider: "codex" as const,
            providerInstanceId: "codex" as const,
            status: bindingStatus,
            runtimePayload: { activeTurnId: null },
          },
        ]),
    } as unknown as ProviderSessionDirectoryShape;
    const provider = {
      listSessions: () => Effect.succeed([providerSession]),
      getRuntimeEventPumpHealth: () =>
        Effect.succeed([
          {
            provider: "codex" as const,
            status: "recovering" as const,
            consecutiveFailures: 1,
            updatedAt: "2026-07-23T20:00:00.000Z",
          },
        ]),
    } as unknown as ProviderServiceShape;

    const runtimeEvents = {
      hasPendingEventsForThreads: (input: { readonly threadIds: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          expect(input.threadIds).toEqual([THREAD_ID]);
          return false;
        }),
    } as unknown as ProviderRuntimeEventRepositoryShape;

    const layer = makeProviderRuntimeReconcilerLive({ staleAfterMs: 1 }).pipe(
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(Layer.succeed(OrchestrationReactor, reactor)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
      Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
      Layer.provide(Layer.succeed(ProviderService, provider)),
      Layer.provide(Layer.succeed(ProviderRuntimeEventRepository, runtimeEvents)),
    );

    await Effect.gen(function* () {
      const reconciler = yield* ProviderRuntimeReconciler;
      yield* reconciler.reconcileNow;
      // The projection can remain stale for another observation cycle.
      yield* reconciler.reconcileNow;
      bindingStatus = "error";
      providerSession = {
        ...providerSession,
        status: "error",
        activeTurnId: TURN_ID,
        lastError: "Provider stream failed.",
      };
      yield* reconciler.reconcileNow;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    // Session repair dispatches first so a partial failure still unsticks the
    // thread, and `updatedAt` is the dispatch time rather than the terminal
    // session's original timestamp (which would freeze the staleness clock).
    expect(commands.map((command) => command.type)).toEqual([
      "thread.session.set",
      "thread.activity.append",
      "thread.session.set",
      "thread.activity.append",
      "thread.session.set",
      "thread.activity.append",
    ]);
    const activityCommand = commands[1];
    expect(activityCommand?.type).toBe("thread.activity.append");
    if (activityCommand?.type === "thread.activity.append") {
      expect(activityCommand.activity.kind).toBe("provider.runtime.reconciled");
      expect(activityCommand.activity.summary).toContain("recovered");
      expect(activityCommand.activity.payload).toMatchObject({
        action: "settle-terminal-projection",
      });
    }
    const sessionCommand = commands[0];
    expect(sessionCommand?.type).toBe("thread.session.set");
    if (sessionCommand?.type === "thread.session.set") {
      expect(sessionCommand.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        lastError: null,
      });
      expect(sessionCommand.session.updatedAt).not.toBe("2026-07-23T19:00:00.000Z");
    }
    const errorActivityCommand = commands[5];
    expect(errorActivityCommand?.type).toBe("thread.activity.append");
    if (errorActivityCommand?.type === "thread.activity.append") {
      expect(errorActivityCommand.activity.payload).toMatchObject({
        action: "settle-error",
      });
    }
    const errorSessionCommand = commands[4];
    expect(errorSessionCommand?.type).toBe("thread.session.set");
    if (errorSessionCommand?.type === "thread.session.set") {
      expect(errorSessionCommand.session).toMatchObject({
        status: "error",
        activeTurnId: TURN_ID,
        lastError: "Provider stream failed.",
      });
    }
    const activityCommands = commands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
        command.type === "thread.activity.append",
    );
    const sessionCommands = commands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.session.set" }> =>
        command.type === "thread.session.set",
    );
    expect(activityCommands[0]?.activity.id).toBe(activityCommands[1]?.activity.id);
    expect(activityCommands[0]?.activity.id).toBe(activityCommands[2]?.activity.id);
    expect(activityCommands[0]?.commandId).not.toBe(activityCommands[1]?.commandId);
    expect(activityCommands[1]?.commandId).not.toBe(activityCommands[2]?.commandId);
    expect(sessionCommands[0]?.commandId).not.toBe(sessionCommands[1]?.commandId);
    expect(sessionCommands[1]?.commandId).not.toBe(sessionCommands[2]?.commandId);
    expect(reconcileSettledOpenTurns).toHaveBeenCalledTimes(3);
  });
});
