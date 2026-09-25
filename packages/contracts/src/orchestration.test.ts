import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ClientOrchestrationCommand,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationGetTurnDiffInput,
  OrchestrationReadModel,
  ProjectCreatedPayload,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThreadPullRequest,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderStartOptions,
  ProjectCreateCommand,
  THREAD_NOTES_MAX_CHARS,
  THREAD_GOAL_MAX_CHARS,
  ThreadMetaUpdatedPayload,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadTurnDiff,
  ThreadHandoff,
  ThreadTurnStartRequestedPayload,
} from "./orchestration";

const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);
const decodeProjectCreateCommand = Schema.decodeUnknownEffect(ProjectCreateCommand);
const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);
const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);

const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);
const decodeProviderStartOptions = Schema.decodeUnknownEffect(ProviderStartOptions);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeThreadPullRequest = Schema.decodeUnknownEffect(OrchestrationThreadPullRequest);

it.effect("decodes last-known PRs persisted before draft/mergeability/diff fields existed", () =>
  Effect.gen(function* () {
    const legacy = yield* decodeThreadPullRequest({
      number: 42,
      title: "Legacy PR",
      url: "https://github.com/o/r/pull/42",
      baseBranch: "main",
      headBranch: "feature/legacy",
      state: "open",
    });
    assert.equal(legacy.number, 42);
    assert.equal(legacy.isDraft, undefined);
    assert.equal(legacy.mergeability, undefined);

    const enriched = yield* decodeThreadPullRequest({
      number: 43,
      title: "Enriched PR",
      url: "https://github.com/o/r/pull/43",
      baseBranch: "main",
      headBranch: "feature/enriched",
      state: "open",
      isDraft: true,
      mergeability: "conflicting",
      additions: 38,
      deletions: 36,
      changedFiles: 3,
    });
    assert.equal(enriched.isDraft, true);
    assert.equal(enriched.mergeability, "conflicting");
    assert.equal(enriched.additions, 38);
  }),
);

it.effect("preserves thread activity payloads through the RPC JSON codec", () =>
  Effect.gen(function* () {
    const codec = Schema.toCodecJson(OrchestrationReadModel);
    const readModel = {
      snapshotSequence: 1,
      spaces: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      projects: [],
      threads: [
        {
          id: "thread-1",
          codexThreadId: null,
          projectId: "project-1",
          title: "Thread 1",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.5",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          envMode: "local",
          branch: null,
          worktreePath: null,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
          createBranchFlowCompleted: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          sidechatSourceThreadId: null,
          lastKnownPr: null,
          handoff: null,
          latestTurn: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [
            {
              id: "activity-1",
              tone: "tool",
              kind: "tool.completed",
              summary: "Ran command",
              payload: {
                itemType: "command_execution",
                data: {
                  item: {
                    command: "git status --short",
                  },
                },
              },
              turnId: null,
              sequence: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          checkpoints: [],
          session: null,
        },
      ],
    };

    const encoded = yield* Schema.encodeUnknownEffect(codec)(readModel);
    const decoded = yield* Schema.decodeUnknownEffect(codec)(encoded);
    const activity = decoded.threads[0]?.activities[0];

    assert.deepStrictEqual(activity?.payload, {
      itemType: "command_execution",
      data: {
        item: {
          command: "git status --short",
        },
      },
    });
  }),
);

it.effect("preserves Pi model selections through the JSON codec", () =>
  Effect.gen(function* () {
    const codec = Schema.fromJsonString(ModelSelection);
    const parsed = yield* Schema.decodeUnknownEffect(codec)(
      JSON.stringify({
        provider: "pi",
        model: "openai/gpt-5.5",
      }),
    );

    assert.deepStrictEqual(parsed, {
      provider: "pi",
      model: "openai/gpt-5.5",
    });
  }),
);

it.effect("drops legacy provider passwords from decoded provider options", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProviderStartOptions({
      opencode: {
        binaryPath: "/custom/bin/opencode",
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: "legacy-opencode-secret",
      },
    });

    assert.deepStrictEqual(parsed, {
      opencode: {
        binaryPath: "/custom/bin/opencode",
        serverUrl: "http://127.0.0.1:4096",
      },
    });
    assert.doesNotMatch(JSON.stringify(parsed), /serverPassword|legacy-.*-secret/);
  }),
);

it.effect("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("keeps generic conversation rollback internal-only", () =>
  Effect.gen(function* () {
    const rollbackCommand = {
      type: "thread.conversation.rollback",
      commandId: "cmd-rollback",
      threadId: "thread-1",
      messageId: "message-1",
      numTurns: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const clientResult = yield* Effect.exit(decodeClientOrchestrationCommand(rollbackCommand));
    assert.strictEqual(clientResult._tag, "Failure");

    const parsedInternal = yield* decodeOrchestrationCommand(rollbackCommand);
    assert.strictEqual(parsedInternal.type, "thread.conversation.rollback");
  }),
);

it.effect("trims branded ids and command string fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: " cmd-1 ",
      projectId: " project-1 ",
      title: " Project Title ",
      workspaceRoot: " /tmp/workspace ",
      defaultModelSelection: {
        provider: "codex",
        model: " gpt-5.2 ",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.commandId, "cmd-1");
    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.deepStrictEqual(parsed.defaultModelSelection, {
      provider: "codex",
      model: "gpt-5.2",
    });
  }),
);

it.effect("decodes historical project.created payloads with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.provider, "codex");
    assert.strictEqual(parsed.isPinned, false);
  }),
);

it.effect("rejects command fields that become empty after trim", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeProjectCreateCommand({
        type: "project.create",
        commandId: "cmd-1",
        projectId: "project-1",
        title: "  ",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes thread.turn.start defaults for provider, runtime mode, and dispatch mode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-1",
      threadId: "thread-1",
      message: {
        messageId: "msg-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection, undefined);
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
    assert.strictEqual(parsed.dispatchMode, "queue");
  }),
);

it.effect("preserves the per-thread computer-control opt-in", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-computer-1",
      threadId: "thread-1",
      message: {
        messageId: "msg-computer-1",
        role: "user",
        text: "use the desktop",
        attachments: [],
      },
      enableComputerControl: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.enableComputerControl, true);
  }),
);

it.effect("bounds initial turn text while preserving attachment-only turns", () =>
  Effect.gen(function* () {
    const command = (text: string, attachments: ReadonlyArray<unknown> = []) => ({
      type: "thread.turn.start",
      commandId: "cmd-turn-input-limit",
      threadId: "thread-1",
      message: { messageId: "msg-input-limit", role: "user", text, attachments },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const exact = yield* decodeThreadTurnStartCommand(
      command("x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
    );
    assert.strictEqual(exact.message.text.length, PROVIDER_SEND_TURN_MAX_INPUT_CHARS);

    const overLimit = yield* Effect.exit(
      decodeThreadTurnStartCommand(command("x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1))),
    );
    assert.strictEqual(overLimit._tag, "Failure");

    const whitespaceOnly = yield* Effect.exit(decodeThreadTurnStartCommand(command("   ")));
    assert.strictEqual(whitespaceOnly._tag, "Failure");

    const attachmentOnly = yield* decodeThreadTurnStartCommand(
      command("", [
        {
          type: "image",
          id: "thread-1-11111111-1111-4111-8111-111111111111",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 1,
        },
      ]),
    );
    assert.strictEqual(attachmentOnly.message.attachments.length, 1);
  }),
);

it.effect("preserves debug mode in thread turns and interaction-mode commands", () =>
  Effect.gen(function* () {
    const turn = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-debug-turn",
      threadId: "thread-1",
      message: {
        messageId: "msg-debug-turn",
        role: "user",
        text: "debug the failing request",
        attachments: [],
      },
      interactionMode: "debug",
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const modeChange = yield* decodeClientOrchestrationCommand({
      type: "thread.interaction-mode.set",
      commandId: "cmd-debug-mode",
      threadId: "thread-1",
      interactionMode: "debug",
      createdAt: "2026-08-11T00:00:00.000Z",
    });

    assert.strictEqual(turn.interactionMode, "debug");
    assert.strictEqual(modeChange.type, "thread.interaction-mode.set");
    if (modeChange.type === "thread.interaction-mode.set") {
      assert.strictEqual(modeChange.interactionMode, "debug");
    }
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.modelSelection.provider, "codex");
  }),
);

it.effect("strips client-sent dispatchOrigin from thread.turn.start commands", () =>
  Effect.gen(function* () {
    // dispatchOrigin is server-assigned (automation engine only). The client command
    // schema deliberately omits it, so a spoofed value must not survive decoding —
    // otherwise any WS client could fake the "Sent via Automation" label.
    const command = yield* decodeClientOrchestrationCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-start-origin",
      threadId: "thread-1",
      message: {
        messageId: "message-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      dispatchMode: "queue",
      dispatchOrigin: "automation",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(command.type, "thread.turn.start");
    assert.strictEqual("dispatchOrigin" in command, false);
  }),
);

it.effect("strips client-sent agent dispatchOrigin from thread.turn.start commands", () =>
  Effect.gen(function* () {
    // The "agent" origin is reserved for turns dispatched through the Synara
    // agent gateway; WS clients must not be able to spoof it either.
    const command = yield* decodeClientOrchestrationCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-start-agent-origin",
      threadId: "thread-1",
      message: {
        messageId: "message-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      dispatchMode: "queue",
      dispatchOrigin: "agent",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(command.type, "thread.turn.start");
    assert.strictEqual("dispatchOrigin" in command, false);
  }),
);

it.effect("rejects oversized thread notes payloads", () =>
  Effect.gen(function* () {
    const failed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      notes: "x".repeat(THREAD_NOTES_MAX_CHARS + 1),
      updatedAt: "2026-01-01T00:00:00.000Z",
    }).pipe(
      Effect.match({
        onFailure: () => true,
        onSuccess: () => false,
      }),
    );
    assert.strictEqual(failed, true);
  }),
);

it.effect("rejects oversized thread goal payloads", () =>
  Effect.gen(function* () {
    const failed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      goal: "x".repeat(THREAD_GOAL_MAX_CHARS + 1),
      updatedAt: "2026-01-01T00:00:00.000Z",
    }).pipe(
      Effect.match({
        onFailure: () => true,
        onSuccess: () => false,
      }),
    );
    assert.strictEqual(failed, true);
  }),
);

it.effect("rejects normalized thread.turn.start commands with too many attachments", () =>
  Effect.gen(function* () {
    const failed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-too-many-attachments",
      threadId: "thread-1",
      message: {
        messageId: "msg-too-many-attachments",
        role: "user",
        text: "hello",
        attachments: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, (_, index) => ({
          type: "image",
          id: `attachment-${index}`,
          name: `image-${index}.png`,
          mimeType: "image/png",
          sizeBytes: 1,
        })),
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    }).pipe(
      Effect.match({
        onFailure: () => true,
        onSuccess: () => false,
      }),
    );
    assert.strictEqual(failed, true);
  }),
);

it.effect("rejects client thread.turn.start commands with too many upload attachments", () =>
  Effect.gen(function* () {
    const failed = yield* decodeClientOrchestrationCommand({
      type: "thread.turn.start",
      commandId: "cmd-client-turn-too-many-attachments",
      threadId: "thread-1",
      message: {
        messageId: "msg-client-too-many-attachments",
        role: "user",
        text: "hello",
        attachments: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, (_, index) => ({
          type: "image",
          id: `thread-1-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          name: `image-${index}.png`,
          mimeType: "image/png",
          sizeBytes: 1,
        })),
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    }).pipe(
      Effect.match({
        onFailure: () => true,
        onSuccess: () => false,
      }),
    );
    assert.strictEqual(failed, true);
  }),
);

it.effect(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(parsed.modelSelection, undefined);
      assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      assert.strictEqual(parsed.dispatchMode, "queue");
      assert.strictEqual(parsed.sourceProposedPlan, undefined);
    }),
);

it.effect("decodes orchestration session runtime mode defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

it.effect("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, null);
    assert.strictEqual(parsed.implementationThreadId, null);
  }),
);

it.effect("preserves user-input answer values through the RPC JSON codec", () =>
  Effect.gen(function* () {
    const codec = Schema.toCodecJson(ClientOrchestrationCommand);
    const wire = {
      type: "thread.user-input.respond",
      commandId: "cmd-1",
      threadId: "thread-1",
      requestId: "req-1",
      answers: {
        single: "Purple",
        multi: ["Reading", "Coding"],
        skipped: null,
      },
      createdAt: "2026-05-19T16:14:28.202Z",
    };
    const decoded = yield* Schema.decodeUnknownEffect(codec)(wire);
    assert.deepStrictEqual(
      (decoded as Extract<typeof decoded, { type: "thread.user-input.respond" }>).answers,
      {
        single: "Purple",
        multi: ["Reading", "Coding"],
        skipped: null,
      },
    );
  }),
);

const decodeThreadHandoff = Schema.decodeUnknownEffect(ThreadHandoff);

it.effect("ThreadHandoff decodes legacy provider names instead of failing the row", () =>
  Effect.gen(function* () {
    const handoff = yield* decodeThreadHandoff({
      sourceThreadId: "thread-src",
      sourceProvider: "kilo",
      importedAt: "2026-01-01T00:00:00Z",
      bootstrapStatus: "completed",
    });
    assert.equal(handoff.sourceProvider, "opencode");

    const renamed = yield* decodeThreadHandoff({
      sourceThreadId: "thread-src",
      sourceProvider: "gemini",
      importedAt: "2026-01-01T00:00:00Z",
      bootstrapStatus: "completed",
    });
    assert.equal(renamed.sourceProvider, "antigravity");

    const current = yield* decodeThreadHandoff({
      sourceThreadId: "thread-src",
      sourceProvider: "codex",
      importedAt: "2026-01-01T00:00:00Z",
      bootstrapStatus: "completed",
    });
    assert.equal(current.sourceProvider, "codex");
  }),
);
