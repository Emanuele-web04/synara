import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ORCHESTRATION_WS_CHANNELS, ORCHESTRATION_WS_METHODS } from "./orchestration";
import { WebSocketRequest, WsResponse, WS_CHANNELS, WS_METHODS } from "./ws";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

it.effect("accepts getTurnDiff requests when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-1",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: "thread-1",
        fromTurnCount: 1,
        toTurnCount: 2,
      },
    });
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
  }),
);

it.effect("rejects getTurnDiff requests when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-1",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
          threadId: "thread-1",
          fromTurnCount: 3,
          toTurnCount: 2,
        },
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims websocket request id and nested orchestration ids", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: " req-1 ",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: " thread-1 ",
        fromTurnCount: 0,
        toTurnCount: 0,
      },
    });
    assert.strictEqual(parsed.id, "req-1");
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
    if (parsed.body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
      assert.strictEqual(parsed.body.threadId, "thread-1");
    }
  }),
);

it.effect("accepts git.preparePullRequestThread requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-pr-1",
      body: {
        _tag: WS_METHODS.gitPreparePullRequestThread,
        cwd: "/repo",
        reference: "#42",
        mode: "worktree",
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.gitPreparePullRequestThread);
  }),
);

it.effect("accepts preview.start requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-preview-1",
      body: {
        _tag: WS_METHODS.previewStart,
        threadId: "thread-1",
        projectId: "project-1",
        cwd: "/repo",
        preferredPort: 5173,
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.previewStart);
  }),
);

it.effect("accepts preview.stopAll requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-preview-stop-all",
      body: {
        _tag: WS_METHODS.previewStopAll,
        threadId: "thread-1",
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.previewStopAll);
  }),
);

it.effect("accepts typed websocket push envelopes with sequence", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 1,
      channel: WS_CHANNELS.serverWelcome,
      data: {
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.type, "push");
    assert.strictEqual(parsed.sequence, 1);
    assert.strictEqual(parsed.channel, WS_CHANNELS.serverWelcome);
  }),
);

it.effect("accepts git.actionProgress push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 3,
      channel: WS_CHANNELS.gitActionProgress,
      data: {
        actionId: "action-1",
        cwd: "/repo",
        action: "commit",
        kind: "phase_started",
        phase: "commit",
        label: "Committing...",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.channel, WS_CHANNELS.gitActionProgress);
  }),
);

it.effect("accepts preview state push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 4,
      channel: WS_CHANNELS.previewEvent,
      data: {
        type: "state",
        state: {
          id: "preview-1",
          threadId: "thread-1",
          projectId: "project-1",
          cwd: "/repo",
          status: "running",
          url: "http://127.0.0.1:5173/",
          port: 5173,
          command: "bun run dev -- --host 127.0.0.1 --port 5173 --strictPort",
          terminalId: "preview-1",
          ownedBySynara: true,
          lastError: null,
          startedAt: "2026-06-05T00:00:00.000Z",
          updatedAt: "2026-06-05T00:00:01.000Z",
        },
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.channel, WS_CHANNELS.previewEvent);
  }),
);

it.effect("accepts preview source-change push envelopes", () =>
  Effect.gen(function* () {
    const state = {
      id: "preview-1",
      threadId: "thread-1",
      projectId: "project-1",
      cwd: "/repo",
      status: "running",
      url: "http://127.0.0.1:5173/",
      port: 5173,
      command: "bun run dev -- --host 127.0.0.1 --port 5173 --strictPort",
      terminalId: "preview-1",
      ownedBySynara: true,
      lastError: null,
      startedAt: "2026-06-05T00:00:00.000Z",
      updatedAt: "2026-06-05T00:00:01.000Z",
    };
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 5,
      channel: WS_CHANNELS.previewEvent,
      data: {
        type: "source-changed",
        state,
        changedPath: "/repo/src/App.tsx",
        changedCount: 2,
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.channel, WS_CHANNELS.previewEvent);
  }),
);

it.effect("rejects push envelopes when channel payload does not match the channel schema", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(WsResponse, {
        type: "push",
        sequence: 2,
        channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
        data: {
          cwd: "/tmp/workspace",
          projectName: "workspace",
        },
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);
