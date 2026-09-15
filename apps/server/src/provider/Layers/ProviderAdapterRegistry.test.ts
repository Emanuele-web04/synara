import {
  EventId,
  ThreadId,
  type ProviderInstanceId,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@synara/contracts";
import { expect } from "vitest";
import { it, assert, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Effect, Layer, Stream } from "effect";

import { AntigravityAdapter, AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";
import { ClaudeAdapter, ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { CodexAdapter, CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { CursorAdapter, CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { DevinAdapter, DevinAdapterShape } from "../Services/DevinAdapter.ts";
import { DroidAdapter, DroidAdapterShape } from "../Services/DroidAdapter.ts";
import { GrokAdapter, GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { OpenCodeAdapter, OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { PiAdapter, PiAdapterShape } from "../Services/PiAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderAdapterRegistryLive } from "./ProviderAdapterRegistry.ts";
import { ProviderUnsupportedError } from "../Errors.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsService } from "../../serverSettings.ts";

const asProviderInstanceId = (value: string): ProviderInstanceId => value as ProviderInstanceId;

const fakeCodexAdapter: CodexAdapterShape = {
  provider: "codex",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeClaudeAdapter: ClaudeAdapterShape = {
  provider: "claudeAgent",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  steerTurn: vi.fn(),
  interruptTurn: vi.fn(),
  stopTask: vi.fn(),
  backgroundTask: vi.fn(),
  steerSubagent: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeCursorAdapter: CursorAdapterShape = {
  provider: "cursor",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeGrokAdapter: GrokAdapterShape = {
  provider: "grok",
  capabilities: { sessionModelSwitch: "restart-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeDroidAdapter: DroidAdapterShape = {
  provider: "droid",
  capabilities: { sessionModelSwitch: "restart-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  forkThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeOpenCodeAdapter: OpenCodeAdapterShape = {
  provider: "opencode",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  forkThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakePiAdapter: PiAdapterShape = {
  provider: "pi",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeDevinAdapter: DevinAdapterShape = {
  provider: "devin",
  capabilities: { sessionModelSwitch: "restart-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeAntigravityAdapter: AntigravityAdapterShape = {
  provider: "antigravity",
  capabilities: { sessionModelSwitch: "restart-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const registryLayer = (codexAdapter = fakeCodexAdapter) =>
  Layer.mergeAll(
    Layer.provide(
      ProviderAdapterRegistryLive,
      Layer.mergeAll(
        Layer.succeed(CodexAdapter, codexAdapter),
        Layer.succeed(ClaudeAdapter, fakeClaudeAdapter),
        Layer.succeed(CursorAdapter, fakeCursorAdapter),
        Layer.succeed(DevinAdapter, fakeDevinAdapter),
        Layer.succeed(AntigravityAdapter, fakeAntigravityAdapter),
        Layer.succeed(GrokAdapter, fakeGrokAdapter),
        Layer.succeed(DroidAdapter, fakeDroidAdapter),
        Layer.succeed(OpenCodeAdapter, fakeOpenCodeAdapter),
        Layer.succeed(PiAdapter, fakePiAdapter),
        ServerSettingsService.layerTest({
          providerInstances: {
            codex_work: {
              driver: "codex",
              displayName: "Codex Work",
              config: { homePath: "/tmp/codex-work" },
            },
            cursor_work: {
              driver: "cursor",
              displayName: "Cursor Work",
            },
            opencode_work: {
              driver: "opencode",
              displayName: "OpenCode Work",
            },
          },
        }),
      ),
    ),
    NodeServices.layer,
  );

const layer = it.layer(registryLayer());

layer("ProviderAdapterRegistryLive", (it) => {
  it.effect("resolves a registered provider adapter", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const codex = yield* registry.getByProvider("codex");
      const claude = yield* registry.getByProvider("claudeAgent");
      const cursor = yield* registry.getByProvider("cursor");
      const devin = yield* registry.getByProvider("devin");
      const antigravity = yield* registry.getByProvider("antigravity");
      const grok = yield* registry.getByProvider("grok");
      const droid = yield* registry.getByProvider("droid");
      const opencode = yield* registry.getByProvider("opencode");
      const pi = yield* registry.getByProvider("pi");
      assert.equal(codex, fakeCodexAdapter);
      assert.equal(claude, fakeClaudeAdapter);
      assert.equal(cursor, fakeCursorAdapter);
      assert.equal(devin, fakeDevinAdapter);
      assert.equal(antigravity, fakeAntigravityAdapter);
      assert.equal(grok, fakeGrokAdapter);
      assert.equal(droid, fakeDroidAdapter);
      assert.equal(opencode, fakeOpenCodeAdapter);
      assert.equal(pi, fakePiAdapter);

      const providers = yield* registry.listProviders();
      assert.deepEqual(providers, [
        "codex",
        "claudeAgent",
        "cursor",
        "devin",
        "antigravity",
        "grok",
        "droid",
        "opencode",
        "pi",
      ]);
    }),
  );

  it.effect("fails with ProviderUnsupportedError for unknown providers", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const adapter = yield* registry.getByProvider("unknown" as ProviderKind).pipe(Effect.result);
      assertFailure(adapter, new ProviderUnsupportedError({ provider: "unknown" }));
    }),
  );

  it.effect("resolves a settings-backed provider instance facade", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      assert.ok(registry.getByInstance);
      assert.ok(registry.listInstances);
      const instanceAdapter = yield* registry.getByInstance(asProviderInstanceId("codex_work"));

      assert.equal(instanceAdapter.provider, "codex");
      assert.notEqual(instanceAdapter, fakeCodexAdapter);
      assert.ok((yield* registry.listInstances()).includes(asProviderInstanceId("codex_work")));
    }),
  );

  it.effect("stamps and filters sessions through the provider instance facade", () =>
    Effect.gen(function* () {
      const workInstanceId = asProviderInstanceId("codex_work");
      const defaultThreadId = ThreadId.makeUnsafe("thread-default");
      const workThreadId = ThreadId.makeUnsafe("thread-work");
      const now = new Date().toISOString();
      const sessions: ProviderSession[] = [
        {
          provider: "codex",
          status: "ready",
          runtimeMode: "full-access",
          threadId: defaultThreadId,
          createdAt: now,
          updatedAt: now,
        },
        {
          provider: "codex",
          providerInstanceId: workInstanceId,
          status: "ready",
          runtimeMode: "full-access",
          threadId: workThreadId,
          createdAt: now,
          updatedAt: now,
        },
      ];
      vi.mocked(fakeCodexAdapter.listSessions).mockReturnValue(Effect.succeed(sessions));

      const registry = yield* ProviderAdapterRegistry;
      assert.ok(registry.getByInstance);
      const instanceAdapter = yield* registry.getByInstance(workInstanceId);
      const instanceSessions = yield* instanceAdapter.listSessions();

      assert.deepEqual(
        instanceSessions.map((session) => session.threadId),
        [workThreadId],
      );
      assert.equal(instanceSessions[0]?.providerInstanceId, workInstanceId);
    }),
  );

  it.effect("routes custom Cursor and OpenCode instance sessions through exact facades", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const cursorThreadId = ThreadId.makeUnsafe("thread-cursor-work");
      const openCodeThreadId = ThreadId.makeUnsafe("thread-opencode-work");
      const cursorSessions = new Map<ThreadId, ProviderSession>();
      const openCodeSessions = new Map<ThreadId, ProviderSession>();

      vi.mocked(fakeCursorAdapter.startSession).mockImplementation((input) =>
        Effect.sync(() => {
          const session: ProviderSession = {
            provider: "cursor",
            ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            createdAt: now,
            updatedAt: now,
          };
          cursorSessions.set(input.threadId, session);
          return session;
        }),
      );
      vi.mocked(fakeCursorAdapter.listSessions).mockImplementation(() =>
        Effect.succeed([...cursorSessions.values()]),
      );
      vi.mocked(fakeCursorAdapter.hasSession).mockImplementation((threadId) =>
        Effect.succeed(cursorSessions.has(threadId)),
      );
      vi.mocked(fakeCursorAdapter.stopSession).mockImplementation((threadId) =>
        Effect.sync(() => {
          cursorSessions.delete(threadId);
        }),
      );

      vi.mocked(fakeOpenCodeAdapter.startSession).mockImplementation((input) =>
        Effect.sync(() => {
          const session: ProviderSession = {
            provider: "opencode",
            ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            createdAt: now,
            updatedAt: now,
          };
          openCodeSessions.set(input.threadId, session);
          return session;
        }),
      );
      vi.mocked(fakeOpenCodeAdapter.listSessions).mockImplementation(() =>
        Effect.succeed([...openCodeSessions.values()]),
      );
      vi.mocked(fakeOpenCodeAdapter.stopSession).mockImplementation((threadId) =>
        Effect.sync(() => {
          openCodeSessions.delete(threadId);
        }),
      );
      vi.mocked(fakeOpenCodeAdapter.hasSession).mockImplementation((threadId) =>
        Effect.succeed(openCodeSessions.has(threadId)),
      );
      vi.mocked(fakeOpenCodeAdapter.stopSession).mockImplementation((threadId) =>
        Effect.sync(() => {
          openCodeSessions.delete(threadId);
        }),
      );

      const registry = yield* ProviderAdapterRegistry;
      assert.ok(registry.getByInstance);
      const cursor = yield* registry.getByInstance(asProviderInstanceId("cursor_work"));
      const openCode = yield* registry.getByInstance(asProviderInstanceId("opencode_work"));

      yield* cursor.startSession({
        threadId: cursorThreadId,
        provider: "cursor",
        runtimeMode: "full-access",
      });
      yield* openCode.startSession({
        threadId: openCodeThreadId,
        provider: "opencode",
        runtimeMode: "full-access",
      });

      assert.equal(yield* cursor.hasSession(cursorThreadId), true);
      assert.equal(yield* openCode.hasSession(openCodeThreadId), true);
      assert.equal((yield* cursor.listSessions())[0]?.providerInstanceId, "cursor_work");
      assert.equal((yield* openCode.listSessions())[0]?.providerInstanceId, "opencode_work");

      yield* cursor.stopSession(cursorThreadId);
      yield* openCode.stopSession(openCodeThreadId);

      assert.equal(yield* cursor.hasSession(cursorThreadId), false);
      assert.equal(yield* openCode.hasSession(openCodeThreadId), false);
    }),
  );

  it.effect("claims untagged sessions created by native instance forks", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const workInstanceId = asProviderInstanceId("opencode_work");
      const sourceThreadId = ThreadId.makeUnsafe("thread-opencode-source");
      const targetThreadId = ThreadId.makeUnsafe("thread-opencode-fork");
      const openCodeSessions = new Map<ThreadId, ProviderSession>();
      const forkThread = fakeOpenCodeAdapter.forkThread;
      assert.ok(forkThread);

      vi.mocked(forkThread).mockImplementation((input) =>
        Effect.sync(() => {
          openCodeSessions.set(input.threadId, {
            provider: "opencode",
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            createdAt: now,
            updatedAt: now,
          });
          return { threadId: input.threadId, resumeCursor: "fork-cursor" };
        }),
      );
      vi.mocked(fakeOpenCodeAdapter.listSessions).mockImplementation(() =>
        Effect.succeed([...openCodeSessions.values()]),
      );

      const registry = yield* ProviderAdapterRegistry;
      assert.ok(registry.getByInstance);
      const workFacade = yield* registry.getByInstance(workInstanceId);
      const defaultFacade = yield* registry.getByInstance(asProviderInstanceId("opencode"));
      assert.ok(workFacade.forkThread);

      yield* workFacade.forkThread({
        sourceThreadId,
        threadId: targetThreadId,
        runtimeMode: "full-access",
      });

      const workSessions = yield* workFacade.listSessions();
      const defaultSessions = yield* defaultFacade.listSessions();
      assert.deepEqual(
        workSessions.map((session) => session.threadId),
        [targetThreadId],
      );
      assert.equal(workSessions[0]?.providerInstanceId, workInstanceId);
      assert.deepEqual(defaultSessions, []);

      yield* workFacade.stopAll();
      openCodeSessions.set(targetThreadId, {
        provider: "opencode",
        status: "ready",
        runtimeMode: "full-access",
        threadId: targetThreadId,
        createdAt: now,
        updatedAt: now,
      });
      assert.deepEqual(
        (yield* defaultFacade.listSessions()).map((session) => session.threadId),
        [targetThreadId],
      );
    }),
  );
});

it("rejects missing required methods while constructing the registry", async () => {
  const malformed = { ...fakeCodexAdapter };
  Reflect.deleteProperty(malformed, "stopAll");

  await expect(
    Effect.runPromise(Effect.provide(Effect.void, registryLayer(malformed))),
  ).rejects.toThrow("required method stopAll() is missing");
});

it("rejects duplicate provider identities while constructing the registry", async () => {
  const duplicate = { ...fakeCodexAdapter };
  Reflect.set(duplicate, "provider", "claudeAgent");

  await expect(
    Effect.runPromise(Effect.provide(Effect.void, registryLayer(duplicate))),
  ).rejects.toThrow("Duplicate provider adapter registrations: claudeAgent at index 1.");
});

it.effect("routes untagged events through the facade that claimed their thread", () => {
  const workInstanceId = asProviderInstanceId("codex_work");
  const workThreadId = ThreadId.makeUnsafe("thread-work-event");
  const defaultThreadId = ThreadId.makeUnsafe("thread-default-event");
  const now = new Date().toISOString();
  const events: ProviderRuntimeEvent[] = [workThreadId, defaultThreadId].map((threadId, index) => ({
    type: "runtime.warning",
    eventId: EventId.makeUnsafe(`event-${index}`),
    provider: "codex",
    threadId,
    createdAt: now,
    payload: { message: `warning-${index}` },
  }));
  const adapter: CodexAdapterShape = {
    ...fakeCodexAdapter,
    startSession: (input) =>
      Effect.succeed({
        provider: "codex",
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        createdAt: now,
        updatedAt: now,
      }),
    streamEvents: Stream.fromIterable(events),
  };

  return Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry;
    assert.ok(registry.getByInstance);
    const workFacade = yield* registry.getByInstance(workInstanceId);
    const defaultFacade = yield* registry.getByInstance(asProviderInstanceId("codex"));

    yield* workFacade.startSession({
      threadId: workThreadId,
      provider: "codex",
      runtimeMode: "full-access",
    });

    const workEvents = yield* Stream.runCollect(workFacade.streamEvents);
    const defaultEvents = yield* Stream.runCollect(defaultFacade.streamEvents);
    assert.deepEqual(
      Array.from(workEvents, (event) => event.threadId),
      [workThreadId],
    );
    assert.deepEqual(
      Array.from(defaultEvents, (event) => event.threadId),
      [defaultThreadId],
    );
  }).pipe(Effect.provide(registryLayer(adapter)));
});
