// FILE: ProviderCommandReactor.sessionLifecycle.test.ts
// Purpose: ProviderCommandReactor cases for provider instances, resume cursors, transcript recaps, Stop and interrupt routing, and user-input responses.
// Layer: Orchestration integration tests
// Depends on: providerCommandReactorHarness (ProviderCommandReactorLive with in-memory provider
//             and persistence services).
// Note: one contiguous slice of the former single ProviderCommandReactor.test.ts, in its
//       original order, so CI can run the slices on separate workers.

import type { ModelSelection, OrchestrationSession } from "@synara/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
} from "@synara/contracts";
import { Duration, Deferred, Effect, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ComputerManager } from "../../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../../computer/FakeComputerBackend.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../../provider/Errors.ts";
import type { ProviderAdapterShape } from "../../provider/Services/ProviderAdapter.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { PROVIDER_COMMAND_REACTOR_CONSUMER } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { type ProviderRuntimeSessionStopTarget } from "../../provider/Services/ProviderService.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import {
  asProjectId,
  asApprovalRequestId,
  asMessageId,
  asTurnId,
  waitFor,
  createRetainingRestartProviderServiceLayer,
  useProviderCommandReactorHarness,
} from "../testing/providerCommandReactorHarness.ts";

describe("ProviderCommandReactor", () => {
  const {
    createHarness,
    readHarnessThread,
    startNativeChildTurn,
    dispatchHarnessUserTurn,
    emitHarnessTurnTerminal,
    seedQueuedTurnBehindLiveTurn,
  } = useProviderCommandReactorHarness();

  it("restarts sessions when server-resolved instance options change", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "opencode",
        instanceId: "opencode_work",
        model: "opencode/nemotron-3-super-free",
      },
      serverSettings: {
        providerInstances: {
          opencode_work: {
            driver: "opencode",
            enabled: true,
            environment: [{ name: "OPENCODE_API_KEY", value: "opencode-env-v1", sensitive: true }],
            config: {
              serverUrl: "http://127.0.0.1:4096",
              serverPassword: "opencode-password-v1",
            },
          },
        },
      },
    });
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-opencode-server-options-1",
      messageId: "user-message-opencode-server-options-1",
      text: "first server-side options",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: "opencode",
      providerInstanceId: "opencode_work",
      providerOptions: {
        opencode: {
          serverUrl: "http://127.0.0.1:4096",
          serverPassword: "opencode-password-v1",
          environment: {
            OPENCODE_API_KEY: "opencode-env-v1",
          },
        },
      },
    });

    await Effect.runPromise(
      harness.serverSettings.updateSettings({
        providerInstances: {
          opencode_work: {
            driver: "opencode",
            enabled: true,
            environment: [{ name: "OPENCODE_API_KEY", value: "opencode-env-v2", sensitive: true }],
            config: {
              serverUrl: "http://127.0.0.1:4096",
              serverPassword: "opencode-password-v2",
            },
          },
        },
      }),
    );

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-opencode-server-options-2",
      messageId: "user-message-opencode-server-options-2",
      text: "updated server-side options",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: "opencode",
      providerInstanceId: "opencode_work",
      providerOptions: {
        opencode: {
          serverUrl: "http://127.0.0.1:4096",
          serverPassword: "opencode-password-v2",
          environment: {
            OPENCODE_API_KEY: "opencode-env-v2",
          },
        },
      },
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
  });

  it("memoizes empty options across session-set events and refreshes them on a later turn", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "opencode",
        instanceId: "opencode_work",
        model: "opencode/nemotron-3-super-free",
      },
      serverSettings: {
        providerInstances: {
          opencode_work: { driver: "opencode", enabled: true, environment: [], config: {} },
        },
      },
    });
    const now = new Date().toISOString();
    const session = {
      threadId: ThreadId.makeUnsafe("thread-1"),
      status: "ready" as const,
      providerName: "opencode" as const,
      providerInstanceId: "opencode_work",
      runtimeMode: "approval-required" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    };
    let settingsReads = 0;
    const getSettings = harness.serverSettings.getSettings;
    Object.assign(harness.serverSettings, {
      getSettings: getSettings.pipe(Effect.tap(() => Effect.sync(() => (settingsReads += 1)))),
    });

    const readsPerSessionSet: number[] = [];
    for (const commandId of ["empty-options-session-set-1", "empty-options-session-set-2"]) {
      const settingsReadsBefore = settingsReads;
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(commandId),
          threadId: ThreadId.makeUnsafe("thread-1"),
          session,
          createdAt: now,
        }),
      );
      await harness.drain();
      readsPerSessionSet.push(settingsReads - settingsReadsBefore);
    }
    expect(readsPerSessionSet[1]).toBeLessThan(readsPerSessionSet[0] ?? 0);

    await Effect.runPromise(
      harness.serverSettings.updateSettings({
        providerInstances: {
          opencode_work: {
            driver: "opencode",
            enabled: true,
            environment: [{ name: "OPENCODE_API_KEY", value: "opencode-env-v2", sensitive: true }],
            config: {
              serverUrl: "http://127.0.0.1:4096",
              serverPassword: "opencode-password-v2",
            },
          },
        },
      }),
    );

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-opencode-server-options-2",
      messageId: "user-message-opencode-server-options-2",
      text: "updated server-side options",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: "opencode",
      providerInstanceId: "opencode_work",
      providerOptions: {
        opencode: {
          serverUrl: "http://127.0.0.1:4096",
          serverPassword: "opencode-password-v2",
          environment: { OPENCODE_API_KEY: "opencode-env-v2" },
        },
      },
    });
    expect(harness.startSession.mock.calls[0]?.[1]).not.toHaveProperty("resumeCursor");
  });

  it("rejects a live session after its provider instance is disabled", async () => {
    const modelSelection: ModelSelection = {
      provider: "codex",
      instanceId: "codex_work",
      model: "gpt-5.4",
    };
    const harness = await createHarness({
      threadModelSelection: modelSelection,
      serverSettings: {
        providerInstances: {
          codex_work: {
            driver: "codex",
            enabled: true,
            config: { homePath: "/tmp/codex-work" },
          },
        },
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-enabled-instance"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-enabled-instance"),
          role: "user",
          text: "start on the enabled work account",
          attachments: [],
        },
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.serverSettings.updateSettings({
        providerInstances: {
          codex_work: {
            driver: "codex",
            enabled: false,
            config: { homePath: "/tmp/codex-work" },
          },
        },
      }),
    );

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-disabled-live-instance",
      messageId: "user-message-disabled-live-instance",
      text: "do not reuse the disabled work account",
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringMatching(/disabled/),
      },
    });
  });

  it("starts an unbound thread on the requested provider instance", async () => {
    const harness = await createHarness({
      serverSettings: {
        providerInstances: {
          claude_work: {
            driver: "claudeAgent",
            enabled: true,
          },
        },
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unbound-instance-switch"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unbound-instance-switch"),
          role: "user",
          text: "start this with claude work",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          instanceId: "claude_work",
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: "claudeAgent",
      providerInstanceId: "claude_work",
      modelSelection: {
        provider: "claudeAgent",
        instanceId: "claude_work",
        model: "claude-opus-4-6",
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "claudeAgent",
        instanceId: "claude_work",
        model: "claude-opus-4-6",
      },
    });
  });

  it("allows stopped threads to start on a different provider instance", async () => {
    const harness = await createHarness({
      serverSettings: {
        providerInstances: {
          codex_work: {
            driver: "codex",
            enabled: true,
            config: {
              homePath: "/tmp/codex-work",
            },
          },
        },
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-stopped-instance-switch"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "stopped",
          providerName: "codex",
          providerInstanceId: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-stopped-instance-switch"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-stopped-instance-switch"),
          role: "user",
          text: "restart on work account",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          instanceId: "codex_work",
          model: "gpt-5.4",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: "codex",
      providerInstanceId: "codex_work",
      modelSelection: {
        instanceId: "codex_work",
        model: "gpt-5.4",
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        instanceId: "codex_work",
        model: "gpt-5.4",
      },
    });
  });

  it("allows stopped edit-resend replays to start on a different provider instance", async () => {
    const harness = await createHarness({
      serverSettings: {
        providerInstances: {
          codex_work: {
            driver: "codex",
            enabled: true,
            config: {
              homePath: "/tmp/codex-work",
            },
          },
        },
      },
    });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-original-turn-start-stopped-edit"),
        threadId,
        message: {
          messageId: asMessageId("user-message-stopped-edit"),
          role: "user",
          text: "old prompt",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          instanceId: "codex",
          model: "gpt-5.4",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.makeUnsafe("cmd-assistant-complete-stopped-edit"),
        threadId,
        messageId: asMessageId("assistant-stopped-edit"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );
    await Effect.runPromise(harness.stopRuntimeSession({ threadId }));
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-stopped-edit-instance-switch"),
        threadId,
        session: {
          threadId,
          status: "stopped",
          providerName: "codex",
          providerInstanceId: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.startSession.mockClear();
    harness.sendTurn.mockClear();
    harness.stopRuntimeSession.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-edit-stopped-instance-resend"),
        threadId,
        messageId: asMessageId("user-message-stopped-edit"),
        text: "edited prompt for work account",
        modelSelection: {
          provider: "codex",
          instanceId: "codex_work",
          model: "gpt-5.4",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.stopRuntimeSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: "codex",
      providerInstanceId: "codex_work",
      modelSelection: {
        instanceId: "codex_work",
        model: "gpt-5.4",
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      input: "edited prompt for work account",
      modelSelection: {
        instanceId: "codex_work",
        model: "gpt-5.4",
      },
    });
  });

  it("allows a valid provider instance retry after an unknown instance error", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-missing-instance"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "start on the removed account",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          instanceId: "codex_removed",
          model: "gpt-5.4",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.session?.status === "error";
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(thread?.session).toMatchObject({
      status: "error",
      providerName: "codex",
      providerInstanceId: "codex_removed",
      lastError: expect.stringContaining("Unknown provider instance 'codex_removed'."),
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-valid-instance-retry"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-valid-instance-retry"),
          role: "user",
          text: "retry on the valid account",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          instanceId: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: "codex",
      providerInstanceId: "codex",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5-codex",
      },
    });

    const retriedReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const retriedThread = retriedReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(retriedThread?.modelSelection).toEqual({
      provider: "codex",
      instanceId: "codex",
      model: "gpt-5-codex",
    });
  });

  it.each([
    {
      name: "same-provider instance changes",
      modelSelection: { provider: "codex", instanceId: "codex_work", model: "gpt-5.4" },
      detail: "cannot switch to 'codex_work'",
    },
    {
      name: "provider changes",
      modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
      detail: "cannot switch to 'claudeAgent'",
    },
  ] as const)(
    "rejects $name after a thread is already bound",
    async ({ modelSelection, detail }) => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      const startTurn = (id: string, text: string, selection?: typeof modelSelection) =>
        Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`cmd-turn-start-${id}`),
            threadId: ThreadId.makeUnsafe("thread-1"),
            message: {
              messageId: asMessageId(`user-message-${id}`),
              role: "user",
              text,
              attachments: [],
            },
            ...(selection ? { modelSelection: selection } : {}),
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: now,
          }),
        );

      await startTurn("binding-first", "first");
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await startTurn("binding-second", "second", modelSelection);

      await waitFor(async () => {
        const thread = await readHarnessThread(harness);
        return (
          thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
          false
        );
      });

      expect(harness.startSession.mock.calls.length).toBe(1);
      expect(harness.sendTurn.mock.calls.length).toBe(1);
      expect(harness.stopSession.mock.calls.length).toBe(0);

      const thread = await readHarnessThread(harness);
      expect(thread?.session).toMatchObject({
        threadId: "thread-1",
        providerName: "codex",
        runtimeMode: "approval-required",
      });
      expect(thread?.modelSelection).toEqual({
        provider: "codex",
        instanceId: "codex",
        model: "gpt-5-codex",
      });
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
      ).toMatchObject({ payload: { detail: expect.stringContaining(detail) } });
    },
  );

  it("hands a bound thread off to another account of its provider in place", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const harness = await createHarness({
      serverSettings: {
        providerInstances: {
          codex_work: {
            driver: "codex",
            displayName: "Work",
            enabled: true,
            config: { homePath: "/tmp/codex-work" },
          },
        },
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-account-handoff-1"),
        threadId,
        message: {
          messageId: asMessageId("user-message-account-handoff-1"),
          role: "user",
          text: "first turn on the default account",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-account-handoff"),
        threadId,
        modelSelection: { provider: "codex", instanceId: "codex_work", model: "gpt-5.4" },
        providerHandoff: true,
      }),
    );

    await waitFor(async () =>
      Boolean(
        (await readHarnessThread(harness))?.activities.some(
          (activity) => activity.kind === "provider.handoff",
        ),
      ),
    );
    // Stop the source runtime while the replacement is still starting.
    expect(harness.stopRuntimeSession).toHaveBeenCalledWith({ threadId });
    expect(harness.clearSessionResumeCursor).not.toHaveBeenCalled();
    expect(harness.startSession.mock.calls).toHaveLength(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: "codex",
      providerInstanceId: "codex_work",
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    const thread = await readHarnessThread(harness);
    expect(thread?.session?.providerInstanceId).toBe("codex_work");
    expect(thread?.modelSelection).toMatchObject({ provider: "codex", instanceId: "codex_work" });
    const handoffActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.handoff",
    );
    expect(handoffActivity?.payload).toMatchObject({
      sourceModelSelection: { provider: "codex", instanceId: "codex" },
      targetModelSelection: { provider: "codex", instanceId: "codex_work" },
    });
    // The provider alone would read the same on both sides, so the target names its account.
    expect(handoffActivity?.summary).toBe(
      "Handed off from Codex (gpt-5-codex) to Codex · Work (gpt-5.4)",
    );
  });

  it.each([false, true])(
    "keeps the native cursor with the source account during a handoff (target rejects: %s)",
    async (targetRejects) => {
      const sourceCursor = { resume: "source-native-session" };
      const targetAccountId = "claude_work";
      const serverSettings = {
        providerInstances: {
          [targetAccountId]: { driver: "claudeAgent" as const, enabled: true },
        },
      };
      const starts = vi.fn(
        (input: Parameters<ProviderAdapterShape<ProviderAdapterError>["startSession"]>[0]) =>
          targetRejects && input.providerInstanceId === targetAccountId,
      );
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "sonnet" },
        serverSettings,
        providerServiceLayer: createRetainingRestartProviderServiceLayer({
          failFirstTeardown: false,
          serverSettings,
          failStart: starts,
          // The target can start before the adapter has a native cursor to persist.
          startResumeCursor: (input) =>
            input.providerInstanceId === targetAccountId
              ? undefined
              : (input.resumeCursor ?? sourceCursor),
        }),
      });
      const repository = harness.providerRuntimeRepository;
      if (!repository) throw new Error("Expected real provider persistence");
      const threadId = ThreadId.makeUnsafe("thread-1");
      const send = async (id: string) => {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(id),
            threadId,
            message: {
              messageId: asMessageId(id),
              role: "user",
              text: "Continue",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: new Date().toISOString(),
          }),
        );
        await harness.drain();
      };
      await send("account-handoff-initial-turn");
      const binding = async () =>
        Option.getOrThrow(await Effect.runPromise(repository.getByThreadId({ threadId })));
      expect(await binding()).toMatchObject({
        providerInstanceId: "claudeAgent",
        resumeCursor: sourceCursor,
      });

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("account-handoff-switch"),
          threadId,
          modelSelection: { provider: "claudeAgent", instanceId: targetAccountId, model: "sonnet" },
          providerHandoff: true,
        }),
      );
      await harness.drain();
      const targetStart = starts.mock.calls.find(
        ([input]) => input.providerInstanceId === targetAccountId,
      );
      expect(targetStart?.[0]).toBeDefined();
      expect(targetStart?.[0].resumeCursor).toBeUndefined();
      const thread = await readHarnessThread(harness);
      expect(thread?.activities.map((activity) => activity.kind)).toContain(
        targetRejects ? "provider.handoff.failed" : "provider.handoff",
      );

      if (targetRejects) {
        expect(thread?.modelSelection.instanceId).toBe("claudeAgent");
        expect(await binding()).toMatchObject({
          providerInstanceId: "claudeAgent",
          resumeCursor: sourceCursor,
          status: "stopped",
        });
        await send("account-handoff-retry-source");
        expect(starts.mock.lastCall?.[0]).toMatchObject({
          providerInstanceId: "claudeAgent",
          resumeCursor: sourceCursor,
        });
      } else {
        expect(await binding()).toMatchObject({
          providerInstanceId: targetAccountId,
          resumeCursor: null,
        });
      }
    },
  );

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail(new Error("simulated restart failure")) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(
      async () => (await readHarnessThread(harness))?.runtimeMode === "approval-required",
    );
    await harness.drain();
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-restart-failure-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const thread = await readHarnessThread(harness);
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.runtimeMode).toBe("approval-required");
    expect(thread?.session?.runtimeMode).toBe("full-access");
    expect(await Effect.runPromise(harness.listSessions())).toEqual(
      expect.arrayContaining([expect.objectContaining({ runtimeMode: "full-access" })]),
    );
    expect(thread?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "provider.turn.start.failed",
          payload: expect.objectContaining({
            detail: expect.stringContaining("simulated restart failure"),
          }),
        }),
      ]),
    );
  });

  it("reconfigures the live permission mode when the projection already claims the requested mode", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-permission-projection-initial"),
        threadId,
        message: {
          messageId: asMessageId("permission-projection-initial"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    const currentSession = (await readHarnessThread(harness))?.session;
    expect(currentSession).toBeDefined();
    if (!currentSession) throw new Error("Expected an established provider session");
    // A failed rebind used to project the requested mode without changing the
    // process. A later dispatch must consult the actual runtime even if such
    // stale state has already been persisted.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-permission-projection-stale"),
        threadId,
        session: { ...currentSession, runtimeMode: "approval-required" },
        createdAt: now,
      }),
    );
    expect(await Effect.runPromise(harness.listSessions())).toEqual(
      expect.arrayContaining([expect.objectContaining({ runtimeMode: "full-access" })]),
    );

    await dispatchHarnessUserTurn(harness, {
      messageId: "permission-projection-next-turn",
      text: "second",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(await Effect.runPromise(harness.listSessions())).toEqual(
      expect.arrayContaining([expect.objectContaining({ runtimeMode: "approval-required" })]),
    );
    expect((await readHarnessThread(harness))?.session?.runtimeMode).toBe("approval-required");
  });

  it.each([
    {
      name: "a failed Pi restart",
      provider: "pi",
      model: "openai/gpt-4o",
      staleProjection: false,
      switchTo: undefined,
    },
    {
      name: "a failed Pi restart the projection already claims",
      provider: "pi",
      model: "openai/gpt-4o",
      staleProjection: true,
      switchTo: undefined,
    },
    {
      name: "a failed Antigravity restart",
      provider: "antigravity",
      model: "gemini-3-pro",
      staleProjection: false,
      switchTo: undefined,
    },
    {
      name: "a failed switch away from Pi",
      provider: "pi",
      model: "openai/gpt-4o",
      staleProjection: false,
      switchTo: { provider: "grok", model: "grok-code-fast-1" },
    },
  ] as const)(
    "reports the permissions of a context kept after $name",
    async ({ provider, model, staleProjection, switchTo }) => {
      // Through the real ProviderService and adapter registry. The teardown of
      // the old context fails, so the service keeps it out of the live listing
      // while its process may still run with the permissions it started with.
      const harness = await createHarness({
        threadModelSelection: { provider, model },
        providerServiceLayer: createRetainingRestartProviderServiceLayer(),
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const now = new Date().toISOString();
      const startTurn = (id: string, runtimeMode: "full-access" | "approval-required") =>
        Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`cmd-${id}`),
            threadId,
            message: { messageId: asMessageId(id), role: "user", text: id, attachments: [] },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode,
            createdAt: now,
          }),
        );

      await startTurn("retained-rebind-first", "full-access");
      await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "ready");
      await harness.drain();
      expect((await readHarnessThread(harness))?.session).toMatchObject({
        providerName: provider,
        runtimeMode: "full-access",
      });

      const settled = (await readHarnessThread(harness))?.session;
      if (!settled) throw new Error("Expected an established provider session");
      const setSession = (id: string, session: OrchestrationSession) =>
        Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe(`cmd-${id}`),
            threadId,
            session,
            createdAt: now,
          }),
        );
      if (staleProjection) {
        // An earlier failed rebind can leave the projection claiming the
        // requested mode, so only the process listing knows the real one.
        await setSession("retained-rebind-stale", { ...settled, runtimeMode: "approval-required" });
      }
      if (switchTo) {
        // A switch saved while a turn runs waits for the next turn start.
        await setSession("retained-rebind-running", {
          ...settled,
          status: "running",
          activeTurnId: asTurnId(`${provider}-turn`),
        });
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-retained-rebind-switch"),
            threadId,
            modelSelection: switchTo,
          }),
        );
        await harness.drain();
        await setSession("retained-rebind-settled", settled);
      }
      await startTurn("retained-rebind-second", "approval-required");
      await waitFor(
        async () =>
          (await readHarnessThread(harness))?.activities.some(
            (activity) => activity.kind === "provider.turn.start.failed",
          ) ?? false,
      );
      await harness.drain();

      const thread = await readHarnessThread(harness);
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
      ).toMatchObject({
        payload: { detail: expect.stringContaining("Failed to dispose previous session.") },
      });
      expect(thread?.runtimeMode).toBe("approval-required");
      expect(thread?.session).toMatchObject({ status: "error", runtimeMode: "full-access" });
    },
  );

  it("reports the live session's permissions when the thread also keeps a retained context", async () => {
    // A failed stop of a stale context on another adapter is only logged, so a
    // thread can have a live session and a retained context at once. Its turns
    // run on the live session.
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();
    const harness = await createHarness({
      listRetainedSessions: () =>
        Effect.succeed([
          {
            provider: "pi",
            status: "closed",
            runtimeMode: "approval-required",
            threadId,
            createdAt: now,
            updatedAt: now,
          },
        ]),
    });
    const startTurn = (id: string, runtimeMode: "full-access" | "approval-required") =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-${id}`),
          threadId,
          message: { messageId: asMessageId(id), role: "user", text: id, attachments: [] },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode,
          createdAt: now,
        }),
      );

    await startTurn("live-and-retained-first", "full-access");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail(new Error("simulated restart failure")) as never,
    );
    await startTurn("live-and-retained-second", "approval-required");
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    const thread = await readHarnessThread(harness);
    expect(thread?.runtimeMode).toBe("approval-required");
    expect(thread?.session).toMatchObject({
      status: "error",
      providerName: "codex",
      runtimeMode: "full-access",
    });
  });

  it.each(["opencode", "codex", "claudeAgent"] as const)(
    "discards a pending %s transcript recap on explicit session stop",
    async (provider) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model: "openai/gpt-5" },
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const now = new Date().toISOString();
      harness.pendingPriorTranscriptBootstraps.add(threadId);

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe(`${provider}-pending-bootstrap-stop`),
          threadId,
          createdAt: now,
        }),
      );
      await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "stopped");

      expect(harness.completePriorTranscriptBootstrap).toHaveBeenCalledTimes(1);
      expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(false);

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-post-stop-fresh-turn`,
        text: "Start fresh after the explicit stop.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      const sentInput = harness.sendTurn.mock.calls[0]?.[0] as { readonly input?: string };
      expect(sentInput.input).toBe("Start fresh after the explicit stop.");
      expect(harness.completePriorTranscriptBootstrap).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["opencode", "codex", "claudeAgent"] as const)(
    "keeps a fresh %s session usable while stopped-recap cleanup retries",
    async (provider) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model: "openai/gpt-5" },
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const now = new Date().toISOString();
      const cleanupFailure = () =>
        Effect.fail(
          new ProviderValidationError({
            operation: "test.completePriorTranscriptBootstrap",
            issue: "injected transcript cleanup failure",
          }),
        );
      harness.pendingPriorTranscriptBootstraps.add(threadId);
      harness.completePriorTranscriptBootstrap
        .mockImplementationOnce(cleanupFailure)
        .mockImplementationOnce(cleanupFailure);

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe(`${provider}-failed-bootstrap-cleanup-stop`),
          threadId,
          createdAt: now,
        }),
      );
      await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "stopped");

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-cleanup-failure-fresh-turn`,
        text: "Start even though durable cleanup is temporarily unavailable.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.completePriorTranscriptBootstrap).toHaveBeenCalledTimes(2);
      expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(true);

      await Effect.runPromise(harness.stopRuntimeSession({ threadId }));
      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-cleanup-retry-fresh-turn`,
        text: "Retry cleanup without replaying the stopped recap.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.completePriorTranscriptBootstrap).toHaveBeenCalledTimes(3);
      expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(false);
    },
  );

  it.each(["opencode"] as const)(
    "completes an empty pending %s transcript recap after a bare turn",
    async (provider) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model: "openai/gpt-5" },
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const now = new Date().toISOString();
      harness.pendingPriorTranscriptBootstraps.add(threadId);

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-empty-bootstrap-turn`,
        text: "There is no earlier transcript left to restore.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      const sentInput = harness.sendTurn.mock.calls[0]?.[0] as { readonly input?: string };
      expect(sentInput.input).toBe("There is no earlier transcript left to restore.");
      expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
      await emitHarnessTurnTerminal(harness, {
        eventId: `${provider}-empty-bootstrap-completed`,
        provider,
        type: "completed",
      });
      await waitFor(() => harness.completePriorTranscriptBootstrap.mock.calls.length === 1);
      expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(false);
    },
  );

  it.each(["opencode", "claudeAgent"] as const)(
    "retains the %s transcript recap when async prompt submission aborts",
    async (provider) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model: "openai/gpt-5" },
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const rejectedTurnId = asTurnId(`${provider}-async-bootstrap-rejected`);
      const retryTurnId = asTurnId(`${provider}-async-bootstrap-retry`);
      const now = new Date().toISOString();
      harness.pendingPriorTranscriptBootstraps.add(threadId);
      harness.sendTurn
        .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: rejectedTurnId }))
        .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: retryTurnId }));

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-async-bootstrap-first-turn`,
        text: "This message must survive asynchronous prompt rejection.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();

      if (provider === "claudeAgent") {
        harness.setRuntimeSessionTurnState({
          threadId,
          status: "running",
          activeTurnId: rejectedTurnId,
        });
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-pending-claude-bootstrap-steer"),
            threadId,
            message: {
              messageId: asMessageId("pending-claude-bootstrap-steer"),
              role: "user",
              text: "Focus on the current recovery turn.",
              attachments: [],
            },
            dispatchMode: "steer",
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: now,
          }),
        );
        await harness.drain();
        expect(harness.steerTurn).toHaveBeenCalledTimes(1);
        expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
        harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
      }

      await emitHarnessTurnTerminal(harness, {
        eventId: `${provider}-async-bootstrap-aborted`,
        provider,
        type: "aborted",
        turnId: rejectedTurnId,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
      expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(true);
      expect(
        (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        ),
      ).toEqual([]);

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-async-bootstrap-retry-turn`,
        text: "Retry after the asynchronous rejection.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);

      const retryInput = harness.sendTurn.mock.calls[1]?.[0] as { readonly input?: string };
      expect(retryInput.input).toContain("<thread_context>");
      expect(retryInput.input).toContain(
        "This message must survive asynchronous prompt rejection.",
      );
      expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();

      await emitHarnessTurnTerminal(harness, {
        eventId: `${provider}-async-bootstrap-retry-completed`,
        provider,
        type: "completed",
        turnId: retryTurnId,
      });
      await waitFor(() => harness.completePriorTranscriptBootstrap.mock.calls.length === 1);
      expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(false);
      await waitFor(async () => {
        const lifecycleActivities = (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        );
        return lifecycleActivities?.length === 1;
      });
      const [lifecycleActivity] = (await readHarnessThread(harness))?.activities.filter(
        (activity) => activity.kind === "provider.context.changed",
      ) ?? [undefined];
      expect(lifecycleActivity).toMatchObject({
        turnId: retryTurnId,
        payload: {
          provider,
          nativeHistory: "unavailable",
          sessionRestarted: false,
          restartReason: "fresh-session",
          recapInjected: true,
        },
      });
    },
  );

  it.each(["opencode"] as const)(
    "lets the %s sidechat bootstrap satisfy the durable transcript recap",
    async (provider) => {
      const threadId = ThreadId.makeUnsafe(`thread-${provider}-sidechat-bootstrap`);
      const harness = await createHarness();
      const now = new Date().toISOString();

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.fork.create",
          commandId: CommandId.makeUnsafe(`cmd-${provider}-sidechat-create`),
          threadId,
          sourceThreadId: ThreadId.makeUnsafe("thread-1"),
          sidechatSourceThreadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: `${provider} sidechat`,
          modelSelection: { provider, model: "openai/gpt-5" },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          envMode: "local",
          branch: null,
          worktreePath: null,
          importedMessages: [
            {
              messageId: asMessageId(`${provider}-sidechat-imported-user`),
              role: "user",
              text: "The imported sidechat color is amber.",
              createdAt: now,
              updatedAt: now,
            },
            {
              messageId: asMessageId(`${provider}-sidechat-imported-assistant`),
              role: "assistant",
              text: "I will retain amber for this sidechat.",
              createdAt: now,
              updatedAt: now,
            },
          ],
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-${provider}-sidechat-turn`),
          threadId,
          message: {
            messageId: asMessageId(`${provider}-sidechat-native-user`),
            role: "user",
            text: "Which color did the sidechat retain?",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      const sentInput = harness.sendTurn.mock.calls[0]?.[0] as { readonly input?: string };
      expect(sentInput.input).toContain("<sidechat_context>");
      expect(sentInput.input).not.toContain("<thread_context>");
      expect(sentInput.input).toContain("The imported sidechat color is amber.");
      expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
      await emitHarnessTurnTerminal(harness, {
        eventId: `${provider}-sidechat-bootstrap-completed`,
        provider,
        type: "completed",
        threadId,
      });
      await waitFor(() => harness.completePriorTranscriptBootstrap.mock.calls.length === 1);
      expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(false);
    },
  );

  it.each(["opencode"] as const)(
    "sends the post-idle %s turn bare after native resume succeeds",
    async (provider) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model: "openai/gpt-5" },
      });
      const now = new Date().toISOString();

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-resume-seed`,
        text: "Remember that the module is called zorblax.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await Effect.runPromise(
        harness.stopRuntimeSession({ threadId: ThreadId.makeUnsafe("thread-1") }),
      );

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-resume-follow-up`,
        text: "What did we call the module?",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);

      expect(harness.startSessionWithOutcome).toHaveBeenCalledTimes(2);
      expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
      const resumedInput = harness.sendTurn.mock.calls[1]?.[0] as { readonly input?: string };
      expect(resumedInput.input).toBe("What did we call the module?");
      const resumedThread = await readHarnessThread(harness);
      expect(
        resumedThread?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        ),
      ).toEqual([]);
    },
  );

  it("preserves pending transcript context for an idle-stopped OpenCode session", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "opencode", model: "openai/gpt-5" },
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      messageId: "opencode-idle-stopped-seed",
      text: "The idle-stopped session must retain cobalt.",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(harness.clearSessionResumeCursor({ threadId }));
    harness.pendingPriorTranscriptBootstraps.add(threadId);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-opencode-idle-stopped"),
        threadId,
        session: {
          threadId,
          status: "stopped",
          providerName: "opencode",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await dispatchHarnessUserTurn(harness, {
      messageId: "opencode-idle-stopped-follow-up",
      text: "Which color must the idle-stopped session retain?",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    const resumedInput = harness.sendTurn.mock.calls[1]?.[0] as { readonly input?: string };
    expect(resumedInput.input).toContain("<thread_context>");
    expect(resumedInput.input).toContain("The idle-stopped session must retain cobalt.");
    expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
  });

  it.each(["opencode", "devin", "grok", "codex", "claudeAgent"] as const)(
    "injects transcript context when %s rejects the persisted resume cursor",
    async (provider) => {
      let rejectNativeResume = true;
      const harness = await createHarness({
        threadModelSelection: { provider, model: "openai/gpt-5" },
        confirmNativeResume: () => !rejectNativeResume,
      });
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("thread-1");

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-rejected-resume-seed`,
        text: "The retained codename is heliotrope.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await Effect.runPromise(harness.stopRuntimeSession({ threadId }));
      if (provider === "codex") {
        harness.sendTurn.mockImplementationOnce(() =>
          Effect.fail(
            new ProviderAdapterValidationError({
              provider,
              operation: "turn/start",
              issue: "Rejected before provider acknowledgement",
            }),
          ),
        );
        await dispatchHarnessUserTurn(harness, {
          messageId: `${provider}-rejected-resume-unaccepted`,
          text: "This recovery attempt was not accepted.",
          createdAt: now,
        });
        await harness.drain();
        expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(true);
        expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
      }
      const followUpSendIndex = harness.sendTurn.mock.calls.length;

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-rejected-resume-follow-up`,
        text: "What is the retained codename?",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === followUpSendIndex + 1);
      await harness.drain();

      const followUpInput = harness.sendTurn.mock.calls[followUpSendIndex]?.[0] as {
        readonly input?: string;
      };
      expect(followUpInput.input).toContain("<thread_context>");
      expect(followUpInput.input).toContain("The retained codename is heliotrope.");
      expect(followUpInput.input?.match(/What is the retained codename\?/g)).toHaveLength(1);
      if (provider === "codex") {
        // Codex's acknowledgement accepts the recap; no terminal event is needed.
        expect(harness.completePriorTranscriptBootstrap).toHaveBeenCalledTimes(1);
      } else {
        expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
        expect(
          (await readHarnessThread(harness))?.activities.filter(
            (activity) => activity.kind === "provider.context.changed",
          ),
        ).toEqual([]);
      }
      await emitHarnessTurnTerminal(harness, {
        eventId: `${provider}-rejected-resume-bootstrap-completed`,
        provider,
        type: "completed",
      });
      await waitFor(() => harness.completePriorTranscriptBootstrap.mock.calls.length === 1);
      const [lifecycleActivity] = (await readHarnessThread(harness))?.activities.filter(
        (activity) => activity.kind === "provider.context.changed",
      ) ?? [undefined];
      expect(lifecycleActivity).toMatchObject({
        payload: {
          provider,
          nativeHistory: "unavailable",
          recapInjected: true,
          ...(provider === "codex"
            ? {}
            : { sessionRestarted: true, restartReason: "native-resume-failed" }),
        },
      });
      rejectNativeResume = false;
      const resumedSendIndex = harness.sendTurn.mock.calls.length;
      await Effect.runPromise(harness.stopRuntimeSession({ threadId }));
      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-accepted-resume-follow-up`,
        text: "Continue with the restored native history.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === resumedSendIndex + 1);
      expect(harness.sendTurn.mock.calls[resumedSendIndex]?.[0].input).toBe(
        "Continue with the restored native history.",
      );
      expect(harness.completePriorTranscriptBootstrap).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["opencode"] as const)(
    "injects one transcript recap for a cursor-less %s cold start",
    async (provider) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model: "openai/gpt-5" },
      });
      const now = new Date().toISOString();
      const coldHistory = `The deployment color is violet. ${"Retained detail. ".repeat(80)}`;
      let lifecycleDispatchAttempts = 0;
      let allowLifecycleDispatch = false;
      harness.interceptEngineDispatch((command) => {
        if (
          command.type !== "thread.activity.append" ||
          command.activity.kind !== "provider.context.changed"
        ) {
          return undefined;
        }
        lifecycleDispatchAttempts += 1;
        return allowLifecycleDispatch
          ? undefined
          : Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Injected transient accepted-bootstrap lifecycle failure.",
              }),
            );
      });

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-cold-seed`,
        text: coldHistory,
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await Effect.runPromise(
        harness.clearSessionResumeCursor({ threadId: ThreadId.makeUnsafe("thread-1") }),
      );

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-cold-follow-up`,
        text: "Which deployment color did we choose?",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      const coldStartInput = harness.sendTurn.mock.calls[1]?.[0] as { readonly input?: string };
      expect(coldStartInput.input).toContain("<thread_context>");
      expect(coldStartInput.input).toContain("The deployment color is violet.");
      expect(coldStartInput.input?.match(/Which deployment color did we choose\?/g)).toHaveLength(
        1,
      );
      expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
      expect(
        (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        ),
      ).toEqual([]);
      harness.setRuntimeSessionTurnState({
        threadId: "thread-1",
        status: "running",
        activeTurnId: asTurnId("turn-1"),
      });
      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-cold-next`,
        text: "Continue with that choice.",
        createdAt: now,
      });
      await harness.drain();
      expect(harness.sendTurn).toHaveBeenCalledTimes(2);
      harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
      await emitHarnessTurnTerminal(harness, {
        eventId: `${provider}-cold-bootstrap-completed`,
        provider,
        type: "completed",
      });
      await waitFor(() => lifecycleDispatchAttempts >= 2);
      expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
      allowLifecycleDispatch = true;
      await waitFor(() => harness.completePriorTranscriptBootstrap.mock.calls.length === 1);
      await waitFor(async () => {
        const lifecycleActivities = (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        );
        return lifecycleActivities?.length === 1;
      });
      expect(lifecycleDispatchAttempts).toBe(3);
      const [lifecycleActivity] = (await readHarnessThread(harness))?.activities.filter(
        (activity) => activity.kind === "provider.context.changed",
      ) ?? [undefined];
      expect(lifecycleActivity).toMatchObject({
        tone: "error",
        summary: "The session's history was lost, so the model continues from a summary.",
        turnId: asTurnId("turn-1"),
        payload: {
          provider,
          nativeHistory: "unavailable",
          sessionRestarted: true,
          restartReason: "fresh-session",
          recapInjected: true,
          recapPreviewTruncated: true,
        },
      });
      const lifecyclePayload = lifecycleActivity?.payload as
        | { recapCharacters?: number; recapPreview?: string }
        | undefined;
      expect(lifecyclePayload?.recapCharacters).toBeGreaterThan(600);
      expect(lifecyclePayload?.recapPreview?.length).toBeLessThanOrEqual(600);
      expect(lifecyclePayload?.recapPreview).toContain("Retained detail.");

      await waitFor(() => harness.sendTurn.mock.calls.length === 3);
      const nextInput = harness.sendTurn.mock.calls[2]?.[0] as { readonly input?: string };
      expect(nextInput.input).toBe("Continue with that choice.");
      expect(
        (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        ),
      ).toHaveLength(1);
    },
  );

  it("discloses omitted and shortened transcript messages in the recovery activity", async () => {
    const provider = "opencode";
    const harness = await createHarness({
      threadModelSelection: { provider, model: "openai/gpt-5" },
    });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("import-long-recovery-history"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: Array.from({ length: 160 }, (_, index) => ({
          messageId: asMessageId(`recovery-history-${index}`),
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
          text: `Historical decision ${index}: ${"detail ".repeat(60)}`,
          createdAt: now,
          updatedAt: now,
        })),
        createdAt: now,
      }),
    );
    await dispatchHarnessUserTurn(harness, {
      messageId: "recovery-seed",
      text: "Keep the most recent release decision.",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(
      harness.clearSessionResumeCursor({ threadId: ThreadId.makeUnsafe("thread-1") }),
    );
    await dispatchHarnessUserTurn(harness, {
      messageId: "recovery-follow-up",
      text: "Continue the release.",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await emitHarnessTurnTerminal(harness, {
      eventId: "recovery-bootstrap-completed",
      provider,
      type: "completed",
    });
    await waitFor(
      async () =>
        (await readHarnessThread(harness))?.activities.some(
          (activity) => activity.kind === "provider.context.changed",
        ) === true,
    );
    const recoveryActivity = (await readHarnessThread(harness))?.activities.findLast(
      (activity) => activity.kind === "provider.context.changed",
    );
    expect(recoveryActivity?.summary).toMatch(
      /^Summary: 67 messages omitted; 88 messages shortened\./,
    );
    expect(recoveryActivity?.summary).not.toContain("Historical decision");
  });

  it.each(["opencode"] as const)(
    "retries a stale %s resume once with transcript context and one user turn",
    async (provider) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model: "openai/gpt-5" },
      });
      const now = new Date().toISOString();

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-stale-seed`,
        text: "Keep the release channel on delta.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await Effect.runPromise(
        harness.stopRuntimeSession({ threadId: ThreadId.makeUnsafe("thread-1") }),
      );
      harness.startSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider,
            method: "session.update",
            detail: provider === "opencode" ? "Session not found" : "status=404 body={}",
          }),
        ),
      );

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-stale-follow-up`,
        text: "Which release channel should we use?",
        createdAt: now,
      });
      await waitFor(async () => {
        const thread = await readHarnessThread(harness);
        return harness.sendTurn.mock.calls.length === 2 || thread?.session?.status === "error";
      });

      expect(harness.startSession.mock.calls).toHaveLength(3);
      expect(harness.clearSessionResumeCursor).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn.mock.calls).toHaveLength(2);
      const retryInput = harness.sendTurn.mock.calls[1]?.[0] as { readonly input?: string };
      expect(retryInput.input).toContain("<thread_context>");
      expect(retryInput.input).toContain("Keep the release channel on delta.");
      expect(retryInput.input?.match(/Which release channel should we use\?/g)).toHaveLength(1);
      expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
      expect(
        (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        ),
      ).toEqual([]);
      await emitHarnessTurnTerminal(harness, {
        eventId: `${provider}-stale-resume-bootstrap-completed`,
        provider,
        type: "completed",
      });
      await waitFor(() => harness.completePriorTranscriptBootstrap.mock.calls.length === 1);
      await waitFor(async () => {
        const lifecycleActivities = (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        );
        return lifecycleActivities?.length === 1;
      });
      const [lifecycleActivity] = (await readHarnessThread(harness))?.activities.filter(
        (activity) => activity.kind === "provider.context.changed",
      ) ?? [undefined];
      expect(lifecycleActivity).toMatchObject({
        tone: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          provider,
          nativeHistory: "unavailable",
          sessionRestarted: true,
          restartReason: "native-resume-failed",
          recapInjected: true,
        },
      });
    },
  );

  it("does not retry a stale OpenCode resume when cursor cleanup fails", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "opencode", model: "openai/gpt-5" },
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      messageId: "opencode-cleanup-failure-seed",
      text: "Keep native context until cleanup succeeds.",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(harness.stopRuntimeSession({ threadId }));
    harness.startSession.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "opencode",
          method: "session.update",
          detail: "Session not found",
        }),
      ),
    );
    harness.clearSessionResumeCursor.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderValidationError({
          operation: "test.clearSessionResumeCursor",
          issue: "injected cursor cleanup failure",
        }),
      ),
    );

    await dispatchHarnessUserTurn(harness, {
      messageId: "opencode-cleanup-failure-follow-up",
      text: "Do not retry past failed cleanup.",
      createdAt: now,
    });
    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.clearSessionResumeCursor).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("retains OpenCode transcript bootstrap state when durable completion fails", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "opencode", model: "openai/gpt-5" },
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      messageId: "opencode-completion-failure-seed",
      text: "The durable bootstrap value is amber.",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(harness.clearSessionResumeCursor({ threadId }));
    const firstBootstrapTurnId = asTurnId("opencode-completion-failure-first-turn");
    const retryBootstrapTurnId = asTurnId("opencode-completion-failure-retry-turn");
    harness.sendTurn
      .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: firstBootstrapTurnId }))
      .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: retryBootstrapTurnId }));

    await dispatchHarnessUserTurn(harness, {
      messageId: "opencode-completion-failure-first",
      text: "Restore the durable value.",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    harness.completePriorTranscriptBootstrap.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderValidationError({
          operation: "test.completePriorTranscriptBootstrap",
          issue: "injected durable completion failure",
        }),
      ),
    );
    await emitHarnessTurnTerminal(harness, {
      eventId: "opencode-completion-failure-terminal",
      provider: "opencode",
      type: "completed",
      turnId: firstBootstrapTurnId,
    });
    await waitFor(() => harness.completePriorTranscriptBootstrap.mock.calls.length === 1);

    await dispatchHarnessUserTurn(harness, {
      messageId: "opencode-completion-failure-retry",
      text: "Retry after durable completion failed.",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 3);

    const retryInput = harness.sendTurn.mock.calls[2]?.[0] as { readonly input?: string };
    expect(retryInput.input).toContain("<thread_context>");
    expect(retryInput.input).toContain("The durable bootstrap value is amber.");
    await emitHarnessTurnTerminal(harness, {
      eventId: "opencode-completion-retry-terminal",
      provider: "opencode",
      type: "completed",
      turnId: retryBootstrapTurnId,
    });
    await waitFor(() => harness.completePriorTranscriptBootstrap.mock.calls.length === 2);
    expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(false);
  });

  it.each(["opencode"] as const)(
    "does not discard the %s resume cursor for a transient session update failure",
    async (provider) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model: "openai/gpt-5" },
      });
      const now = new Date().toISOString();

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-transient-seed`,
        text: "Keep this native context.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await Effect.runPromise(
        harness.stopRuntimeSession({ threadId: ThreadId.makeUnsafe("thread-1") }),
      );
      harness.startSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider,
            method: "session.update",
            detail: "status=503 body=temporarily unavailable",
          }),
        ),
      );

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-transient-follow-up`,
        text: "Retry later without losing it.",
        createdAt: now,
      });
      await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");

      expect(harness.startSession).toHaveBeenCalledTimes(2);
      expect(harness.clearSessionResumeCursor).not.toHaveBeenCalled();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
    },
  );

  it("records a consequential cold start when no recap is available for the provider", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    let lifecycleDispatchAttempts = 0;
    harness.interceptEngineDispatch((command) => {
      if (
        command.type !== "thread.activity.append" ||
        command.activity.kind !== "provider.context.changed"
      ) {
        return undefined;
      }
      lifecycleDispatchAttempts += 1;
      return lifecycleDispatchAttempts === 1
        ? Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Injected transient lifecycle activity failure.",
            }),
          )
        : undefined;
    });

    await dispatchHarnessUserTurn(harness, {
      messageId: "codex-context-seed",
      text: "Keep the migration order stable.",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(
      harness.clearSessionResumeCursor({ threadId: ThreadId.makeUnsafe("thread-1") }),
    );

    await dispatchHarnessUserTurn(harness, {
      messageId: "codex-context-cold-start",
      text: "What should stay stable?",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    const coldStartInput = harness.sendTurn.mock.calls[1]?.[0] as { readonly input?: string };
    expect(coldStartInput.input).toBe("What should stay stable?");

    await waitFor(async () => {
      const lifecycleActivities = (await readHarnessThread(harness))?.activities.filter(
        (activity) => activity.kind === "provider.context.changed",
      );
      return lifecycleActivities?.length === 1;
    });
    expect(lifecycleDispatchAttempts).toBe(2);

    const [lifecycleActivity] = (await readHarnessThread(harness))?.activities.filter(
      (activity) => activity.kind === "provider.context.changed",
    ) ?? [undefined];
    expect(lifecycleActivity).toMatchObject({
      tone: "error",
      summary: "The session restarted without its previous history.",
      turnId: asTurnId("turn-1"),
      payload: {
        provider: "codex",
        nativeHistory: "unavailable",
        sessionRestarted: true,
        restartReason: "native-history-unavailable",
        recapInjected: false,
        recapCharacters: 0,
        recapPreview: null,
        recapPreviewTruncated: false,
      },
    });
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
  });

  it.each(["ready", "interrupted", "stopped", "missing"] as const)(
    "ignores a repeated Stop on an idle %s session while still pausing the goal",
    async (status) => {
      const harness = await createHarness();
      const threadId = ThreadId.makeUnsafe("thread-1");
      const createdAt = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("idle-stop-goal"),
          threadId,
          goal: "Keep the user's goal paused after Stop",
          goalStartBehavior: "defer",
        }),
      );
      if (status !== "missing") {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("idle-stop-session"),
            threadId,
            session: {
              threadId,
              status,
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        );
        if (status !== "stopped") harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
      }
      for (const attempt of [1, 2]) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe(`idle-stop-${attempt}`),
            threadId,
            createdAt,
          }),
        );
      }
      await harness.drain();
      const thread = await readHarnessThread(harness);
      expect(thread?.goalPausedAt).toEqual(expect.any(String));
      expect(thread?.activities.filter((activity) => activity.tone === "error")).toEqual([]);
      expect(harness.interruptTurn).not.toHaveBeenCalled();
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    },
  );

  it.each(["starting", "stopped"] as const)(
    "preserves queued work when the observed startup runtime was replaced with projection %s before teardown",
    async (projectionStatus) => {
      const harness = await createHarness();
      const threadId = ThreadId.makeUnsafe("thread-1");
      const createdAt = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("fenced-startup-session"),
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      harness.setRuntimeSessionTurnState({ threadId, status: "connecting" });
      if (projectionStatus === "stopped") {
        const runtimes = await Effect.runPromise(harness.listSessions());
        harness.listSessions.mockImplementationOnce(() =>
          harness.engine
            .dispatch({
              type: "thread.session.set",
              commandId: CommandId.makeUnsafe("replacement-startup-stopped-projection"),
              threadId,
              session: {
                threadId,
                status: "stopped",
                providerName: "codex",
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                updatedAt: new Date(Date.parse(createdAt) + 1_000).toISOString(),
              },
              createdAt,
            })
            .pipe(Effect.as(runtimes), Effect.orDie),
        );
      }
      const cancelQueued = vi.spyOn(harness.queuedTurnPromotionRepository, "cancelThread");
      harness.pendingPriorTranscriptBootstraps.add(threadId);
      harness.stopRuntimeSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderValidationError({
            operation: "ProviderService.stopRuntimeSession",
            reason: "stale-interaction",
            issue: "The provider runtime changed after Stop was requested.",
          }),
        ),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("stale-startup-stop"),
          threadId,
          createdAt,
        }),
      );
      await harness.drain();
      expect(cancelQueued).not.toHaveBeenCalled();
      expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(true);
      expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
      expect((await readHarnessThread(harness))?.session?.status).toBe(projectionStatus);
      expect(await Effect.runPromise(harness.listSessions())).toHaveLength(1);
      expect(harness.sendTurn).not.toHaveBeenCalled();
    },
  );

  it.each(["starting", "ready"] as const)(
    "does not drop connecting Stop after the same runtime's projection updates to %s",
    async (status) => {
      const harness = await createHarness();
      const threadId = ThreadId.makeUnsafe("thread-1");
      const createdAt = new Date().toISOString();
      const session = {
        threadId,
        status: "starting" as const,
        providerName: "codex" as const,
        runtimeMode: "approval-required" as const,
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
      };
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("connecting-before-update"),
          threadId,
          session,
          createdAt,
        }),
      );
      harness.setRuntimeSessionTurnState({ threadId, status: "connecting" });
      const sessions = await Effect.runPromise(harness.listSessions());
      let updatePending = true;
      harness.listSessions.mockImplementation(() =>
        Effect.gen(function* () {
          if (updatePending) {
            updatePending = false;
            const updatedAt = new Date(Date.parse(createdAt) + 1_000).toISOString();
            yield* harness.engine
              .dispatch({
                type: "thread.session.set",
                commandId: CommandId.makeUnsafe("connecting-progress-update"),
                threadId,
                session: { ...session, status, updatedAt },
                createdAt: updatedAt,
              })
              .pipe(Effect.orDie);
          }
          return sessions;
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("stop-before-progress-update"),
          threadId,
          createdAt,
        }),
      );
      await harness.drain();
      expect((await readHarnessThread(harness))?.session?.status).toBe("stopped");
      expect(harness.stopRuntimeSession).toHaveBeenCalledTimes(1);
      expect(harness.interruptTurn).not.toHaveBeenCalled();
      expect(await Effect.runPromise(harness.listSessions())).toEqual([]);
    },
  );

  it.each(["ProviderService.interruptTurn", "ProviderService.stopRuntimeSession"] as const)(
    "does not settle a live turn when %s cannot acquire the observed runtime",
    async (operation) => {
      const harness = await createHarness({
        interruptTurn: () =>
          Effect.fail(
            new ProviderValidationError({
              operation,
              reason: "stale-interaction",
              issue: "The provider lifecycle is busy.",
            }),
          ),
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const turnId = asTurnId("busy-conditional-turn");
      const createdAt = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("busy-conditional-session"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      harness.setRuntimeSessionTurnState({ threadId, status: "running", activeTurnId: turnId });
      const cancelQueued = vi.spyOn(harness.queuedTurnPromotionRepository, "cancelThread");
      harness.pendingPriorTranscriptBootstraps.add(threadId);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("busy-conditional-stop"),
          threadId,
          turnId,
          createdAt,
        }),
      );
      await harness.drain();
      expect((await readHarnessThread(harness))?.session).toMatchObject({
        status: "running",
        activeTurnId: turnId,
      });
      expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
      expect(cancelQueued).not.toHaveBeenCalled();
      expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(true);
    },
  );

  it("preserves a replacement parent's authority and child queue when escalated child Stop is stale", async () => {
    const harness = await createHarness();
    const parent = ThreadId.makeUnsafe("thread-1");
    const child = ThreadId.makeUnsafe("subagent:thread-1:stale-stop-child");
    const turnId = asTurnId("stale-child-turn");
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("stale-stop-child-create"),
        threadId: child,
        parentThreadId: parent,
        projectId: asProjectId("project-1"),
        title: "Running child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    for (const threadId of [parent, child]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(`stale-stop-${threadId}`),
          threadId,
          session: {
            threadId,
            status: threadId === child ? "running" : "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: threadId === child ? turnId : null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
    }
    harness.setRuntimeSessionTurnState({ threadId: parent, status: "ready" });
    harness.interruptTurn
      .mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/interrupt",
            detail: "The child stop was not confirmed.",
          }),
        ),
      )
      .mockImplementationOnce(() =>
        Effect.fail(
          new ProviderValidationError({
            operation: "ProviderService.interruptTurn",
            reason: "stale-interaction",
            issue: "The parent runtime was replaced.",
          }),
        ),
      );
    const cancelQueued = vi.spyOn(harness.queuedTurnPromotionRepository, "cancelThread");
    harness.pendingPriorTranscriptBootstraps.add(child);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("stale-child-stop"),
        threadId: child,
        turnId,
        createdAt,
      }),
    );
    await harness.drain();
    expect(harness.interruptTurn).toHaveBeenCalledTimes(2);
    expect(harness.interruptTurn.mock.calls[1]?.[0]).toEqual({
      threadId: parent,
      turnId,
      providerThreadId: "stale-stop-child",
      controlRequestId: "command:stale-child-stop",
      expectedLifecycleGeneration: null,
    });
    expect(cancelQueued).not.toHaveBeenCalled();
    expect(harness.pendingPriorTranscriptBootstraps.has(child)).toBe(true);
    expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
    expect((await readHarnessThread(harness, child))?.session).toMatchObject({
      status: "running",
      activeTurnId: turnId,
    });
    expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
  });

  it("retries Stop after a transient runtime-target persistence failure before dispatch", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("runtime-target-persistence-session"),
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    harness.setRuntimeSessionTurnState({ threadId, status: "connecting" });
    harness.getRuntimeSessionStopTarget.mockImplementationOnce(() =>
      Effect.fail(
        new PersistenceSqlError({
          operation: "ProviderSessionDirectory.getBinding",
          detail: "transient target read failure",
        }),
      ),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("runtime-target-persistence-stop"),
        threadId,
        createdAt,
      }),
    );
    await harness.drain();
    expect(harness.getRuntimeSessionStopTarget).toHaveBeenCalledTimes(2);
    expect(harness.stopRuntimeSession).toHaveBeenCalledTimes(1);
    expect(await Effect.runPromise(harness.listSessions())).toEqual([]);
    expect((await readHarnessThread(harness))?.session?.status).toBe("stopped");
  });

  async function createRealRunningStopHarness(providerName: "codex" | "cursor") {
    const harness = await createHarness({
      threadModelSelection: {
        provider: providerName,
        model: providerName === "cursor" ? "composer-1" : "gpt-5-codex",
      },
      providerServiceLayer: createRetainingRestartProviderServiceLayer({
        failFirstTeardown: false,
        liveTurns: true,
      }),
    });
    const provider = harness.realProviderService;
    const repository = harness.providerRuntimeRepository;
    if (!repository || !provider.getRuntimeSessionStopTarget)
      throw new Error("Expected real provider persistence");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId(`${providerName}-turn`);
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("real-stop-start"),
        threadId,
        message: {
          messageId: asMessageId("real-stop-first-message"),
          role: "user",
          text: "First turn",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      }),
    );
    await harness.drain();
    const established = (await readHarnessThread(harness))?.session;
    if (!established) throw new Error("Expected an established real runtime");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("real-stop-running"),
        threadId,
        session: { ...established, status: "running", activeTurnId: turnId },
        createdAt,
      }),
    );
    await harness.drain();
    return { harness, provider, repository, threadId, turnId, createdAt };
  }

  it.each([false, true])(
    "rejects an unrecorded real Stop without adopting T2 across retry/restart (error row fails=%s)",
    async (failErrorRow) => {
      const { harness, provider, repository, threadId, turnId, createdAt } =
        await createRealRunningStopHarness("codex");
      const readTarget = provider.getRuntimeSessionStopTarget!;
      let reads = 0;
      let blocked = false;
      const retryReady = Effect.runSync(Deferred.make<void>());
      vi.spyOn(provider, "getRuntimeSessionStopTarget").mockImplementation((input) =>
        Effect.gen(function* () {
          reads++;
          if (reads >= 3) {
            blocked = true;
            yield* Deferred.await(retryReady);
          }
          return yield* readTarget(input);
        }),
      );
      const write = repository.upsert;
      let failed = false;
      vi.spyOn(repository, "upsert").mockImplementation((row) => {
        const payload = row.runtimePayload as { providerStopControlReceipt?: unknown } | null;
        if (!failed && payload?.providerStopControlReceipt) {
          failed = true;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "ProviderSessionRuntimeRepository.upsert",
              detail: "First Stop target write failed once",
            }),
          );
        }
        return write(row);
      });
      let reportFailed = false;
      harness.interceptEngineDispatch((command) => {
        if (
          failErrorRow &&
          !reportFailed &&
          command.type === "thread.activity.append" &&
          command.activity.kind === "provider.turn.interrupt.failed"
        ) {
          reportFailed = true;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "append Stop failure",
              detail: "Error row failed once",
            }),
          );
        }
        return undefined;
      });
      const interrupt = vi.spyOn(provider, "interruptTurn");
      const cancelQueue = vi.spyOn(harness.queuedTurnPromotionRepository, "cancelThread");
      const commandId = CommandId.makeUnsafe("unrecorded-stop-command");
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId,
          threadId,
          turnId,
          createdAt,
        }),
      );
      const source = (
        await Effect.runPromise(
          Stream.runCollect(
            harness.engine.readThreadEvents(threadId, 0, ["thread.turn-interrupt-requested"]),
          ),
        )
      ).find((event) => event.commandId === commandId);
      if (!source) throw new Error("Expected durable Stop request");
      const key = {
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: source.sequence,
      };
      await waitFor(
        async () =>
          blocked ||
          Option.getOrUndefined(
            await Effect.runPromise(harness.deliveryRepository.getDelivery(key)),
          )?.state === "succeeded",
      );
      expect(failed).toBe(true);
      await Effect.runPromise(
        provider.startSession(threadId, {
          threadId,
          provider: "codex",
          runtimeMode: "approval-required",
        }),
      );
      await Effect.runPromise(
        provider.sendTurn({ threadId, input: "Replacement after rejected Stop" }),
      );
      const replacement = await Effect.runPromise(readTarget({ threadId }));
      await Effect.runPromise(Deferred.succeed(retryReady, undefined));
      await harness.drain();
      const afterStop = await Effect.runPromise(readTarget({ threadId }));
      expect(afterStop.session).not.toBeNull();
      expect(afterStop.lifecycleGeneration).toBe(replacement.lifecycleGeneration);
      expect(
        Option.getOrThrow(await Effect.runPromise(harness.deliveryRepository.getDelivery(key))),
      ).toMatchObject({ state: "succeeded", attemptCount: 1 });
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(cancelQueue).not.toHaveBeenCalled();
      expect(reportFailed).toBe(failErrorRow);
      expect((await readHarnessThread(harness))?.session).toMatchObject({
        status: "running",
        activeTurnId: turnId,
      });
      const restarted = await harness.restartReactor();
      await restarted.start();
      await Effect.runPromise(restarted.reactor.drain);
      const afterRestart = await Effect.runPromise(readTarget({ threadId }));
      expect(afterRestart.lifecycleGeneration).toBe(replacement.lifecycleGeneration);
      expect(afterRestart.session).not.toBeNull();
      expect(interrupt).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "preserves queued steer semantics and full direct Goal Stop on SQL replay (directGoalStop=%s)",
    async (directGoalStop) => {
      const { harness, provider, repository, threadId, turnId, createdAt } =
        await createRealRunningStopHarness("cursor");
      if (directGoalStop) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("real-stop-active-goal"),
            threadId,
            goal: "Finish the current objective",
            goalStartBehavior: "defer",
            goalPaused: false,
          }),
        );
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("real-queued-before-goal-stop"),
            threadId,
            message: {
              messageId: asMessageId("real-steer-message"),
              role: "user",
              text: "Queued message before Goal Stop",
              attachments: [],
            },
            dispatchMode: "queue",
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
        );
        await harness.drain();
      }
      const write = repository.upsert;
      let receiptWrites = 0;
      let failed = false;
      vi.spyOn(repository, "upsert").mockImplementation((row) => {
        const receipt = (
          row.runtimePayload as {
            providerStopControlReceipt?: { controlRequestId?: string };
          } | null
        )?.providerStopControlReceipt;
        if (receipt?.controlRequestId === "command:real-steer-command" && ++receiptWrites === 2) {
          failed = true;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "ProviderSessionRuntimeRepository.upsert",
              detail: "Accepted steer retirement write failed once",
            }),
          );
        }
        return write(row);
      });
      const cancelQueue = vi.spyOn(harness.queuedTurnPromotionRepository, "cancelThread");
      const bootstrap = vi.spyOn(provider, "completePriorTranscriptBootstrap");
      const interrupt = vi.spyOn(provider, "interruptTurn");
      const sends = vi.spyOn(provider, "sendTurn");
      if (directGoalStop) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe("real-steer-command"),
            threadId,
            turnId,
            createdAt,
          }),
        );
      } else {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("real-steer-command"),
            threadId,
            message: {
              messageId: asMessageId("real-steer-message"),
              role: "user",
              text: "Steer must survive receipt replay",
              attachments: [],
            },
            dispatchMode: "steer",
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
        );
      }
      await harness.drain();
      const interruptEvent = (
        await Effect.runPromise(
          Stream.runCollect(
            harness.engine.readThreadEvents(threadId, 0, ["thread.turn-interrupt-requested"]),
          ),
        )
      ).find((event) => event.commandId === "real-steer-command");
      expect(interruptEvent).toBeDefined();
      expect(interruptEvent?.causationEventId).not.toBeNull();
      expect(failed).toBe(true);
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(cancelQueue).toHaveBeenCalledTimes(directGoalStop ? 1 : 0);
      expect(bootstrap).toHaveBeenCalledTimes(directGoalStop ? 1 : 0);
      expect(
        await Effect.runPromise(
          harness.queuedTurnPromotionRepository.hasPendingMessage({
            threadId,
            messageId: "real-steer-message",
          }),
        ),
      ).toBe(!directGoalStop);
      const restarted = await harness.restartReactor();
      await restarted.start();
      await Effect.runPromise(restarted.reactor.drain);
      expect(sends).toHaveBeenCalledTimes(directGoalStop ? 0 : 1);
      if (!directGoalStop)
        expect(sends.mock.calls[0]?.[0].input).toContain("Steer must survive receipt replay");
      expect(
        await Effect.runPromise(
          harness.queuedTurnPromotionRepository.hasPendingMessage({
            threadId,
            messageId: "real-steer-message",
          }),
        ),
      ).toBe(false);
      expect(cancelQueue).toHaveBeenCalledTimes(directGoalStop ? 1 : 0);
    },
  );

  it.each([
    { replaceRuntime: false, staleProjection: false, omitTurnId: false },
    { replaceRuntime: true, staleProjection: false, omitTurnId: false },
    { replaceRuntime: false, staleProjection: true, omitTurnId: false },
    { replaceRuntime: false, staleProjection: true, omitTurnId: true, newQueuedWork: false },
    { replaceRuntime: false, staleProjection: true, omitTurnId: true, newQueuedWork: true },
  ])(
    "replays a real Stop after its post-retirement SQL read fails without adopting a replacement (%j)",
    async ({ replaceRuntime, staleProjection, omitTurnId, newQueuedWork = false }) => {
      const harness = await createHarness({
        providerServiceLayer: createRetainingRestartProviderServiceLayer({
          failFirstTeardown: false,
        }),
      });
      const provider = harness.realProviderService;
      const repository = harness.providerRuntimeRepository;
      if (!repository || !provider.getRuntimeSessionStopTarget)
        throw new Error("Expected the real provider persistence fixture");
      const threadId = ThreadId.makeUnsafe("thread-1");
      const turnId = asTurnId("codex-turn");
      const projectedTurnId = staleProjection ? asTurnId("stale-projected-turn") : turnId;
      const createdAt = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("receipt-first-start"),
          threadId,
          message: {
            messageId: asMessageId("receipt-first-message"),
            role: "user",
            text: "Start",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        }),
      );
      await harness.drain();
      const established = (await readHarnessThread(harness))?.session;
      if (!established) throw new Error("Expected an established real provider runtime");
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("receipt-first-running"),
          threadId,
          session: { ...established, status: "running", activeTurnId: projectedTurnId },
          createdAt,
        }),
      );
      await harness.drain();
      const originalTarget = await Effect.runPromise(
        provider.getRuntimeSessionStopTarget({ threadId }),
      );
      let armed = false;
      let failed = false;
      const replayReady = Effect.runSync(Deferred.make<void>());
      const readRuntime = provider.getRuntimeSessionStopTarget;
      vi.spyOn(provider, "getRuntimeSessionStopTarget").mockImplementation((input) =>
        Effect.gen(function* () {
          if (failed) yield* Deferred.await(replayReady);
          return yield* readRuntime(input);
        }),
      );
      const readRow = repository.getByThreadId;
      vi.spyOn(repository, "getByThreadId").mockImplementation((input) =>
        Effect.suspend(() => {
          if (armed && !failed) {
            failed = true;
            return Effect.fail(
              new PersistenceSqlError({
                operation: "ProviderSessionRuntimeRepository.getByThreadId",
                detail: "Injected one post-retirement SQL read fault",
              }),
            );
          }
          return readRow(input);
        }),
      );
      const interrupt = provider.interruptTurn;
      const interruptSpy = vi.spyOn(provider, "interruptTurn").mockImplementation((input) =>
        interrupt(input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              armed = true;
            }),
          ),
        ),
      );
      const stopSpy = vi.spyOn(provider, "stopRuntimeSession");
      const queuedSend = vi.spyOn(provider, "sendTurn");
      const commandId = CommandId.makeUnsafe(`receipt-stop-${replaceRuntime}`);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId,
          threadId,
          ...(!omitTurnId ? { turnId: projectedTurnId } : {}),
          createdAt,
        }),
      );
      await waitFor(() => failed);
      let replacementTarget: ProviderRuntimeSessionStopTarget | undefined;
      if (replaceRuntime) {
        await Effect.runPromise(
          provider.startSession(threadId, {
            threadId,
            provider: "codex",
            runtimeMode: "approval-required",
          }),
        );
        await Effect.runPromise(provider.sendTurn({ threadId, input: "Replacement" }));
        replacementTarget = await Effect.runPromise(readRuntime({ threadId }));
        expect(replacementTarget.lifecycleGeneration).not.toBe(originalTarget.lifecycleGeneration);
        // The new runtime deliberately reuses the exact same provider turn ID.
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("receipt-replacement-running"),
            threadId,
            session: {
              ...established,
              status: "running",
              activeTurnId: turnId,
              updatedAt: new Date().toISOString(),
            },
            createdAt,
          }),
        );
      }
      if (newQueuedWork) {
        // Real command admission while Stop is retrying: the future turn is not
        // allowed to bypass its owning delivery, and must survive its cleanup.
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("receipt-queued-after-stop"),
            threadId,
            message: {
              messageId: asMessageId("receipt-queued-message"),
              role: "user",
              text: "Queued after the first Stop",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            dispatchMode: "queue",
            createdAt: new Date().toISOString(),
          }),
        );
      }
      await Effect.runPromise(Deferred.succeed(replayReady, undefined));
      await harness.drain();
      const source = (
        await Effect.runPromise(
          Stream.runCollect(
            harness.engine.readThreadEvents(threadId, 0, ["thread.turn-interrupt-requested"]),
          ),
        )
      ).find((event) => event.commandId === commandId);
      if (!source) throw new Error("Expected the durable interrupt request");
      const delivery = Option.getOrThrow(
        await Effect.runPromise(
          harness.deliveryRepository.getDelivery({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            eventSequence: source.sequence,
          }),
        ),
      );
      expect(delivery).toMatchObject({ state: "succeeded", attemptCount: 2 });
      expect(interruptSpy).toHaveBeenCalledTimes(1);
      const finalTarget = await Effect.runPromise(readRuntime({ threadId }));
      expect(finalTarget.stopControlReceipt).toMatchObject({
        controlRequestId: `command:${commandId}`,
        turnId,
      });
      if (newQueuedWork) {
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(queuedSend).toHaveBeenCalledTimes(1);
        expect(queuedSend.mock.calls[0]?.[0].input).toContain("Queued after the first Stop");
        expect(finalTarget.session).not.toBeNull();
        expect(finalTarget.lifecycleGeneration).not.toBe(
          finalTarget.stopControlReceipt?.retiredLifecycleGeneration,
        );
        expect((await readHarnessThread(harness))?.session?.status).toBe("ready");
      } else if (replaceRuntime) {
        expect(finalTarget.lifecycleGeneration).toBe(replacementTarget?.lifecycleGeneration);
        expect(finalTarget.session).not.toBeNull();
        expect(stopSpy).not.toHaveBeenCalled();
        expect((await readHarnessThread(harness))?.session).toMatchObject({
          status: "running",
          activeTurnId: turnId,
        });
      } else {
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(finalTarget.session).toBeNull();
        expect(finalTarget.lifecycleGeneration).toBe(
          finalTarget.stopControlReceipt?.retiredLifecycleGeneration,
        );
        expect((await readHarnessThread(harness))?.session?.status).toBe("stopped");
      }
    },
  );

  it("retires only the observed running runtime when its exact turn id is unavailable", async () => {
    const harness = await createHarness({
      interruptTurn: () =>
        Effect.fail(
          new ProviderValidationError({
            operation: "ProviderService.interruptTurn",
            reason: "active-turn-unavailable",
            issue: "The exact active provider turn is unavailable.",
          }),
        ),
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("running-runtime-missing-turn-session"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("projected-missing-runtime-turn"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    harness.setRuntimeSessionTurnState({ threadId, status: "running" });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("running-runtime-missing-turn-stop"),
        threadId,
        createdAt,
      }),
    );
    await harness.drain();
    expect(harness.stopRuntimeSession).toHaveBeenCalledWith({
      threadId,
      controlRequestId: "command:running-runtime-missing-turn-stop",
      expectedLifecycleGeneration: null,
    });
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(await Effect.runPromise(harness.listSessions())).toEqual([]);
    expect((await readHarnessThread(harness))?.session?.status).toBe("stopped");
  });

  it("keeps the escalation explanation when an uncertain Stop detail contains a stack", async () => {
    const harness = await createHarness({
      interruptTurn: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/interrupt",
            detail: "Connection dropped\n    at interrupt (/app/provider.ts:3:1)",
          }),
        ),
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("uncertain-stop-turn");
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("uncertain-stop-session"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    harness.setRuntimeSessionTurnState({ threadId, status: "running", activeTurnId: turnId });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("uncertain-stop-command"),
        threadId,
        turnId,
        createdAt,
      }),
    );
    await harness.drain();
    const thread = await readHarnessThread(harness);
    const failure = thread?.activities.find(
      (activity) => activity.kind === "provider.turn.interrupt.failed",
    );
    const detail = (failure?.payload as { detail?: string } | undefined)?.detail;
    expect(detail).toContain("Stopping the provider session to settle the turn.");
    expect(detail).not.toContain("\n");
    expect(detail).not.toContain(" at interrupt ");
    expect(harness.stopRuntimeSession).toHaveBeenCalledTimes(1);
    expect(await Effect.runPromise(harness.listSessions())).toEqual([]);
  });

  it.each(["starting", "running"] as const)(
    "stops a connecting runtime with no turn while the projection is %s",
    async (status) => {
      const harness = await createHarness({
        interruptTurn: () =>
          Effect.fail(
            new ProviderValidationError({
              operation: "interruptTurn",
              issue: "No exact provider turn is bound during initialization.",
            }),
          ),
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const createdAt = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("connecting-session"),
          threadId,
          session: {
            threadId,
            status,
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      harness.setRuntimeSessionTurnState({ threadId, status: "connecting" });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("stop-initialization"),
          threadId,
          createdAt,
        }),
      );
      await harness.drain();
      const thread = await readHarnessThread(harness);
      expect(thread?.session).toMatchObject({ status: "stopped", activeTurnId: null });
      expect(harness.stopRuntimeSession).toHaveBeenCalledTimes(1);
      expect(harness.interruptTurn).not.toHaveBeenCalled();
      expect(await Effect.runPromise(harness.listSessions())).toEqual([]);
      expect(thread?.activities.filter((activity) => activity.tone === "error")).toEqual([]);
    },
  );

  it("targets the live provider turn when an interrupt carries a stale projected turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-stale-interrupt"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-projected-stale"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-live-current"),
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-stale-projection"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-projected-stale"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-live-current",
      controlRequestId: "command:cmd-turn-interrupt-stale-projection",
      expectedLifecycleGeneration: null,
    });
  });

  it.each([
    { runtimeStatus: "ready", hasTurnId: false, settles: true },
    { runtimeStatus: "running", hasTurnId: true, settles: false },
    { runtimeStatus: "running", hasTurnId: false, settles: false },
  ] as const)(
    "settles an accepted Stop promptly only when the runtime has no live turn ($runtimeStatus)",
    async ({ runtimeStatus, hasTurnId, settles }) => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("thread-1");
      const turnId = asTurnId("turn-stop-after-provider-end");

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-session-set-stop-after-provider-end"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
      // "ready": the provider already ended the turn (or was retired by the
      // interrupt) while its terminal event is still on its way.
      harness.setRuntimeSessionTurnState({
        threadId: "thread-1",
        status: runtimeStatus,
        ...(hasTurnId ? { activeTurnId: turnId } : {}),
      });

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-turn-interrupt-after-provider-end"),
          threadId,
          turnId,
          createdAt: now,
        }),
      );
      await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
      await harness.drain();

      const session = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (thread) => thread.id === threadId,
      )?.session;
      expect(session).toMatchObject(
        settles
          ? { status: "interrupted", activeTurnId: null }
          : { status: "running", activeTurnId: turnId },
      );
    },
  );

  it.each([
    { outcome: "accepted", replacement: "turn" },
    { outcome: "rejected", replacement: "turn" },
    { outcome: "uncertain", replacement: "turn" },
    { outcome: "accepted", replacement: "runtime" },
    { outcome: "rejected", replacement: "runtime" },
    { outcome: "uncertain", replacement: "runtime" },
    { outcome: "rejected", replacement: "retired-runtime" },
    { outcome: "uncertain", replacement: "retired-runtime" },
  ] as const)(
    "does not settle a replacement $replacement when an earlier interrupt finishes ($outcome)",
    async ({ outcome, replacement }) => {
      const interrupted = Promise.withResolvers<void>();
      const harness = await createHarness({
        interruptTurn: () =>
          Effect.tryPromise({
            try: () => interrupted.promise,
            catch: () =>
              outcome === "rejected"
                ? new ProviderValidationError({
                    operation: "interruptTurn",
                    issue: "The earlier turn is no longer active.",
                  })
                : new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "turn/interrupt",
                    detail: "The old connection closed after the request.",
                  }),
          }),
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const now = new Date().toISOString();
      const setProjectedTurn = (turnId: string) =>
        Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe(`cmd-session-${turnId}`),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: asTurnId(turnId),
              lastError: null,
              updatedAt: now,
            },
            createdAt: now,
          }),
        );
      await setProjectedTurn("turn-interrupted");
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "running",
        activeTurnId: asTurnId("turn-interrupted"),
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-interrupt-before-replacement"),
          threadId,
          createdAt: now,
        }),
      );
      await waitFor(() => harness.interruptTurn.mock.calls.length === 1);

      // The next runtime turn already finished, but its terminal event is still
      // pending. Absence of a live turn alone must not settle its projection.
      const replacementTurnId = replacement === "turn" ? "turn-replacement" : "turn-interrupted";
      if (replacement === "turn") await setProjectedTurn(replacementTurnId);
      harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
      if (replacement === "runtime" || replacement === "retired-runtime") {
        const sessions = await Effect.runPromise(harness.listSessions());
        const replacementSession = replacement === "retired-runtime" ? null : sessions[0]!;
        harness.listSessions.mockImplementation(() =>
          Effect.succeed(replacementSession ? [replacementSession] : []),
        );
        harness.getRuntimeSessionStopTarget.mockImplementation(() =>
          Effect.succeed({
            session: replacementSession,
            lifecycleGeneration: "replacement-runtime",
          }),
        );
      }
      if (outcome === "accepted") interrupted.resolve();
      else interrupted.reject(new Error("Old Stop settled after the replacement"));
      await harness.drain();

      expect((await readHarnessThread(harness))?.session).toMatchObject({
        status: "running",
        activeTurnId: replacementTurnId,
      });
      expect((await readHarnessThread(harness))?.latestTurn).toMatchObject({
        turnId: replacementTurnId,
        state: "running",
      });
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
    },
  );

  it.each(["ready", "missing-child-shell", "missing-parent-shell"] as const)(
    "serializes child interrupts with earlier parent-session side effects in owner FIFO with %s projection",
    async (projectionState) => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      const parent = ThreadId.makeUnsafe("thread-1");
      const child = ThreadId.makeUnsafe("subagent:thread-1:owner-fifo-child");
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("create-owner-fifo-child"),
          threadId: child,
          parentThreadId: parent,
          projectId: asProjectId("project-1"),
          title: "Child",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("session-owner-fifo-parent"),
          threadId: parent,
          session: {
            threadId: parent,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            updatedAt: now,
            lastError: null,
          },
          createdAt: now,
        }),
      );
      await Effect.runPromise(harness.reactor.drain.pipe(Effect.timeout("1 second")));
      const entered = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const calls: string[] = [];
      harness.stopTask.mockImplementation(() =>
        Effect.sync(() => calls.push("parent-enter")).pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.sync(() => calls.push("parent-exit"))),
        ),
      );
      harness.interruptTurn.mockImplementation(() =>
        Effect.sync(() => calls.push("child-interrupt")),
      );
      harness.backgroundTask.mockImplementation(() =>
        Effect.sync(() => calls.push("parent-background")),
      );
      try {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.task.stop",
            commandId: CommandId.makeUnsafe("owner-fifo-parent-stop"),
            threadId: parent,
            taskId: "parent-task",
            createdAt: now,
          }),
        );
        await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("1 second")));
        if (projectionState !== "ready") {
          const missingThread = projectionState === "missing-child-shell" ? child : parent;
          const readShell = harness.projectionSnapshotQuery.getThreadShellById;
          vi.spyOn(harness.projectionSnapshotQuery, "getThreadShellById").mockImplementation(
            (threadId) =>
              threadId === missingThread ? Effect.succeed(Option.none()) : readShell(threadId),
          );
        }

        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe("owner-fifo-child-interrupt"),
            threadId: child,
            turnId: asTurnId("child-turn"),
            createdAt: now,
          }),
        );
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.task.background",
            commandId: CommandId.makeUnsafe("owner-fifo-parent-background"),
            threadId: parent,
            toolUseId: "parent-followup",
            createdAt: now,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        await Effect.runPromise(Deferred.succeed(release, undefined));
        await Effect.runPromise(harness.reactor.drain.pipe(Effect.timeout("1 second")));
        expect(calls).toEqual([
          "parent-enter",
          "parent-exit",
          "child-interrupt",
          "parent-background",
        ]);
        expect(harness.interruptTurn.mock.calls[0]![0]).toMatchObject({
          threadId: parent,
          providerThreadId: "owner-fifo-child",
        });
      } finally {
        await Effect.runPromise(Deferred.succeed(release, undefined));
      }
    },
  );

  it("serializes native fork creation with side effects on the source session", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const parent = ThreadId.makeUnsafe("thread-1");
    const target = ThreadId.makeUnsafe("owner-native-fork-target");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("create-owner-native-fork"),
        threadId: target,
        sourceThreadId: parent,
        projectId: asProjectId("project-1"),
        title: "Fork",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [],
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("session-owner-native-parent"),
        threadId: parent,
        session: {
          threadId: parent,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );
    await harness.drain();
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const calls: string[] = [];
    harness.stopTask.mockImplementation(() =>
      Effect.sync(() => calls.push("source-enter")).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Effect.sync(() => calls.push("source-exit"))),
      ),
    );
    harness.forkThread.mockImplementation(() =>
      Effect.sync(() => {
        calls.push("native-fork");
        return null;
      }),
    );
    try {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.task.stop",
          commandId: CommandId.makeUnsafe("owner-fork-source-stop"),
          threadId: parent,
          taskId: "source-task",
          createdAt: now,
        }),
      );
      await Effect.runPromise(Deferred.await(entered));
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("owner-fork-target-start"),
          threadId: target,
          message: {
            messageId: asMessageId("owner-fork-message"),
            role: "user",
            text: "Fork now",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await harness.drain();
      expect(calls).toEqual(["source-enter", "source-exit", "native-fork"]);
      expect(harness.forkThread.mock.calls[0]![0]).toMatchObject({
        sourceThreadId: parent,
        threadId: target,
      });
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
    }
  });

  it.each([
    {
      name: "through the parent provider session using the child provider thread id",
      slug: "subagent",
      childId: "child-provider-1",
      parentMetadata: true,
      childSession: true,
    },
    {
      name: "even when the child thread has no session of its own",
      slug: "subagent-sessionless",
      childId: "child-provider-2",
      parentMetadata: true,
      childSession: false,
    },
    {
      name: "inferring the parent for synthetic ids that are missing parent metadata",
      slug: "subagent-fallback",
      childId: "child-provider-1",
      parentMetadata: false,
      childSession: true,
    },
  ])(
    "routes subagent interrupts $name",
    async ({ slug, childId, parentMetadata, childSession }) => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      const parent = ThreadId.makeUnsafe("thread-1");
      const child = ThreadId.makeUnsafe(`subagent:thread-1:${childId}`);
      const setSession = (
        commandId: string,
        threadId: ThreadId,
        status: "running" | "ready",
        activeTurnId: string | null,
      ) =>
        Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe(commandId),
            threadId,
            session: {
              threadId,
              status,
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: activeTurnId ? asTurnId(activeTurnId) : null,
              lastError: null,
              updatedAt: now,
            },
            createdAt: now,
          }),
        );

      await setSession(
        `cmd-session-set-parent-${slug}`,
        parent,
        childSession ? "running" : "ready",
        childSession ? "turn-parent" : null,
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`cmd-thread-create-${slug}`),
          threadId: child,
          projectId: asProjectId("project-1"),
          title: "Halley [explorer]",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          ...(parentMetadata ? { parentThreadId: parent } : {}),
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
      if (childSession) await setSession(`cmd-session-set-${slug}`, child, "running", "turn-child");

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe(`cmd-turn-interrupt-${slug}`),
          threadId: child,
          createdAt: now,
        }),
      );

      await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
      expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
        threadId: "thread-1",
        ...(childSession ? { turnId: "turn-child" } : {}),
        providerThreadId: childId,
        controlRequestId: `command:cmd-turn-interrupt-${slug}`,
        expectedLifecycleGeneration: null,
      });
    },
  );

  it("steers attachment-only turns through an inferred synthetic subagent parent", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      ingestRuntimeEvents: true,
    });
    const now = new Date().toISOString();
    const attachment = {
      type: "file" as const,
      id: "synthetic-subagent-attachment",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-synthetic-steer-parent"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-synthetic-steer-parent"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-synthetic-steer-child"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-steer"),
        projectId: asProjectId("project-1"),
        title: "Synthetic child",
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    await harness.stageAttachment(attachment, "subagent:thread-1:child-provider-steer");
    await startNativeChildTurn(harness, "child-provider-steer", "claudeAgent");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-synthetic-attachment-steer"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-steer"),
        message: {
          messageId: asMessageId("msg-synthetic-attachment-steer"),
          role: "user",
          text: "",
          attachments: [attachment],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.steerSubagent.mock.calls.length === 1);
    expect(harness.steerSubagent.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      providerThreadId: "child-provider-steer",
      attachments: [attachment],
    });
    expect(harness.startSession).not.toHaveBeenCalledWith(
      ThreadId.makeUnsafe("subagent:thread-1:child-provider-steer"),
      expect.anything(),
    );
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-approval-request-before-response"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-approval-request-before-response"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
            lifecycleGeneration: "approval-generation-1",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        lifecycleGeneration: "approval-generation-1",
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      lifecycleGeneration: "approval-generation-1",
      decision: "accept",
    });
    const respondingApproval = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "approval",
        requestId: asApprovalRequestId("approval-request-1"),
      }),
    );
    expect(Option.getOrUndefined(respondingApproval)).toMatchObject({
      status: "responding",
      responseCommandId: "cmd-approval-respond",
      decision: "accept",
      resolvedAt: null,
    });

    const duplicateFailure = await Effect.runPromise(
      harness.engine
        .dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe("cmd-approval-respond-duplicate"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          requestId: asApprovalRequestId("approval-request-1"),
          lifecycleGeneration: "approval-generation-1",
          decision: "decline",
          createdAt: now,
        })
        .pipe(Effect.flip),
    );
    expect(duplicateFailure._tag).toBe("OrchestrationCommandInvariantError");
    await harness.drain();
    expect(harness.respondToRequest).toHaveBeenCalledTimes(1);
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-user-input"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-user-input-request-before-response"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-user-input-request-before-response"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
            lifecycleGeneration: "user-input-generation-1",
            questions: [],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        lifecycleGeneration: "user-input-generation-1",
        // Single, array, and mixed answer shapes all reach the provider unchanged.
        answers: {
          sandbox_mode: "workspace-write",
          features: ["CLI scaffolding", "Type checking"],
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      lifecycleGeneration: "user-input-generation-1",
      answers: {
        sandbox_mode: "workspace-write",
        features: ["CLI scaffolding", "Type checking"],
      },
    });
    const respondingUserInput = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "userInput",
        requestId: asApprovalRequestId("user-input-request-1"),
      }),
    );
    expect(Option.getOrUndefined(respondingUserInput)).toMatchObject({
      status: "responding",
      responseCommandId: "cmd-user-input-respond",
      decision: null,
      resolvedAt: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond-duplicate"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        lifecycleGeneration: "user-input-generation-1",
        answers: { sandbox_mode: "danger-full-access" },
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.respondToUserInput).toHaveBeenCalledTimes(1);
  });

  it.each(["thread.approval.respond", "thread.user-input.respond"] as const)(
    "does not forward a %s response without a durable pending claim",
    async (type) => {
      const harness = await createHarness();
      const base = {
        commandId: CommandId.makeUnsafe(`cmd-${type}-early`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId(`${type}-request-early`),
        createdAt: new Date().toISOString(),
      };
      await Effect.runPromise(
        harness.engine.dispatch(
          type === "thread.approval.respond"
            ? { type, ...base, decision: "accept" }
            : { type, ...base, answers: { input: "continue" } },
        ),
      );

      await harness.drain();
      expect(harness.respondToRequest).not.toHaveBeenCalled();
      expect(harness.respondToUserInput).not.toHaveBeenCalled();
    },
  );

  it("does not forward approval responses when the projected session is stopped", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-stopped-approval"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "stopped",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-approval-requested-stopped"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-approval-requested-stopped"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: { requestId: "approval-request-stopped", requestKind: "command" },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond-stopped"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-stopped"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some(
          (activity) => activity.kind === "provider.approval.respond.failed",
        ) ?? false
      );
    });
    expect(harness.respondToRequest).not.toHaveBeenCalled();
    const expiredApproval = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "approval",
        requestId: asApprovalRequestId("approval-request-stopped"),
      }),
    );
    expect(Option.getOrUndefined(expiredApproval)).toMatchObject({
      status: "confirmed",
      responseCommandId: "cmd-approval-respond-stopped",
      decision: "accept",
      resolvedAt: expect.any(String),
    });
  });

  it("does not forward user-input responses when the projected session is stopped", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-stopped-user-input"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "stopped",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-user-input-requested-stopped"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-user-input-requested-stopped"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: { requestId: "user-input-request-stopped", questions: [] },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond-stopped"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-stopped"),
        answers: {
          input: "continue",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some(
          (activity) => activity.kind === "provider.user-input.respond.failed",
        ) ?? false
      );
    });
    expect(harness.respondToUserInput).not.toHaveBeenCalled();
    const expiredUserInput = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "userInput",
        requestId: asApprovalRequestId("user-input-request-stopped"),
      }),
    );
    expect(Option.getOrUndefined(expiredUserInput)).toMatchObject({
      status: "confirmed",
      responseCommandId: "cmd-user-input-respond-stopped",
      decision: null,
      resolvedAt: expect.any(String),
    });
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval-error"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-approval-requested"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(
      async () =>
        (await readHarnessThread(harness))?.activities.some(
          (activity) => activity.kind === "provider.approval.respond.failed",
        ) === true,
    );

    const thread = await readHarnessThread(harness);
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      responseCommandId: "cmd-approval-respond-stale",
      settlementStatus: "uncertain",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });
    const expiredApproval = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "approval",
        requestId: asApprovalRequestId("approval-request-1"),
      }),
    );
    expect(Option.getOrUndefined(expiredApproval)).toMatchObject({
      status: "confirmed",
      responseCommandId: "cmd-approval-respond-stale",
      decision: "acceptForSession",
      resolvedAt: failureActivity?.createdAt,
    });
    const responseEvents = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((events) => Array.from(events)),
      ),
    );
    const responseEvent = responseEvents.find(
      (event) => event.commandId === "cmd-approval-respond-stale",
    );
    expect(responseEvent).toBeDefined();
    const responseDelivery = await Effect.runPromise(
      harness.deliveryRepository.getDelivery({
        consumerName: "provider-command-reactor.v1",
        eventSequence: responseEvent!.sequence,
      }),
    );
    expect(responseDelivery.pipe(Option.getOrThrow).state).toBe("succeeded");

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("keeps OpenCode permission acknowledgement failures retryable", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "opencode",
          method: "permission.reply.acknowledge",
          detail: "OpenCode still reports permission approval-request-ack as pending.",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval-ack-error"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "opencode",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-approval-ack-requested"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-approval-ack-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Permission approval requested",
          payload: {
            requestId: "approval-request-ack",
            requestKind: "permissions",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-ack-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-ack"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(
      async () =>
        (await readHarnessThread(harness))?.activities.some(
          (activity) => activity.kind === "provider.approval.respond.failed",
        ) === true,
    );

    const thread = await readHarnessThread(harness);
    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-ack",
      responseCommandId: "cmd-approval-ack-respond",
      settlementStatus: "retryable",
      detail: expect.stringContaining("permission.reply.acknowledge"),
    });

    const retryableApproval = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "approval",
        requestId: asApprovalRequestId("approval-request-ack"),
      }),
    );
    expect(Option.getOrUndefined(retryableApproval)).toMatchObject({
      status: "retryable",
      responseCommandId: "cmd-approval-ack-respond",
      decision: "accept",
      resolvedAt: null,
    });
  });

  it.each(["callback-missing", "runtime-unavailable"] as const)(
    "expires %s user-input failures without faking resolution or retrying a dead callback",
    async (reason) => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      harness.respondToUserInput.mockImplementation(() =>
        Effect.fail(
          reason === "callback-missing"
            ? new ProviderAdapterRequestError({
                provider: "claudeAgent",
                method: "item/tool/respondToUserInput",
                detail: "Unknown pending user-input request: user-input-request-1",
              })
            : new ProviderValidationError({
                operation: "ProviderService.respondToUserInput",
                issue: "Callback runtime no longer exists",
                reason,
              }),
        ),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-session-set-for-user-input-error"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe("cmd-user-input-requested"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          activity: {
            id: EventId.makeUnsafe("activity-user-input-requested"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId: "user-input-request-1",
              questions: [
                {
                  id: "sandbox_mode",
                  header: "Sandbox",
                  question: "Which mode should be used?",
                  options: [
                    {
                      label: "workspace-write",
                      description: "Allow workspace writes only",
                    },
                  ],
                },
              ],
            },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.makeUnsafe("cmd-user-input-respond-stale"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          requestId: asApprovalRequestId("user-input-request-1"),
          answers: {
            sandbox_mode: "workspace-write",
          },
          createdAt: now,
        }),
      );

      await waitFor(
        async () =>
          (await readHarnessThread(harness))?.activities.some(
            (activity) => activity.kind === "provider.user-input.respond.failed",
          ) === true,
      );

      const thread = await readHarnessThread(harness);
      expect(thread).toBeDefined();

      const failureActivity = thread?.activities.find(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
      expect(failureActivity).toBeDefined();
      expect(failureActivity?.payload).toMatchObject({
        requestId: "user-input-request-1",
        responseCommandId: "cmd-user-input-respond-stale",
        settlementStatus: "uncertain",
        detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
      });
      const expiredUserInput = await Effect.runPromise(
        harness.pendingInteractionRepository.getByIdentity({
          threadId: ThreadId.makeUnsafe("thread-1"),
          interactionKind: "userInput",
          requestId: asApprovalRequestId("user-input-request-1"),
        }),
      );
      expect(Option.getOrUndefined(expiredUserInput)).toMatchObject({
        status: "confirmed",
        responseCommandId: "cmd-user-input-respond-stale",
        decision: null,
        resolvedAt: failureActivity?.createdAt,
      });

      const resolvedActivity = thread?.activities.find(
        (activity) =>
          activity.kind === "user-input.resolved" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
      );
      expect(resolvedActivity).toBeUndefined();

      // Explicit invalidation is terminal, unlike an ambiguous delivery failure.
      harness.respondToUserInput.mockImplementation(() => Effect.void);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.makeUnsafe("cmd-user-input-respond-retry"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          requestId: asApprovalRequestId("user-input-request-1"),
          answers: {
            sandbox_mode: "workspace-write",
          },
          createdAt: new Date().toISOString(),
        }),
      );
      await harness.drain();
      expect(
        (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.user-input.respond.failed",
        ),
      ).toHaveLength(1);
      expect(harness.respondToUserInput).toHaveBeenCalledTimes(1);
      const settledUserInputAfterRetry = await Effect.runPromise(
        harness.pendingInteractionRepository.getByIdentity({
          threadId: ThreadId.makeUnsafe("thread-1"),
          interactionKind: "userInput",
          requestId: asApprovalRequestId("user-input-request-1"),
        }),
      );
      expect(Option.getOrUndefined(settledUserInputAfterRetry)).toMatchObject({
        status: "confirmed",
        responseCommandId: "cmd-user-input-respond-stale",
        resolvedAt: failureActivity?.createdAt,
      });
    },
  );

  it("keeps full-context AskUserQuestion rejection retryable across session recovery", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "item/tool/respondToUserInput",
          detail:
            "API Error: 400 input_length and max_tokens exceed context limit; prompt is too long.",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-full-context"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-user-input-requested-full-context"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-user-input-requested-full-context"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-full-context",
            questions: [],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond-full-context"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-full-context"),
        answers: { continue: "Yes" },
        createdAt: now,
      }),
    );

    await waitFor(
      async () =>
        (await readHarnessThread(harness))?.activities.some(
          (activity) => activity.kind === "provider.user-input.respond.failed",
        ) === true,
    );
    const failureActivity = (await readHarnessThread(harness))?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity?.payload).toMatchObject({
      requestId: "user-input-request-full-context",
      responseCommandId: "cmd-user-input-respond-full-context",
      settlementStatus: "retryable",
      detail: expect.stringContaining("context limit"),
    });
    const failedResponse = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "userInput",
        requestId: asApprovalRequestId("user-input-request-full-context"),
      }),
    );
    expect(Option.getOrUndefined(failedResponse)).toMatchObject({
      status: "retryable",
      responseCommandId: "cmd-user-input-respond-full-context",
    });

    const stoppedAt = new Date(Date.now() + 1).toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-stopped-full-context"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "stopped",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: stoppedAt,
        },
        createdAt: stoppedAt,
      }),
    );

    const recoveredAt = new Date(Date.now() + 2).toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-recovered-full-context"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: recoveredAt,
        },
        createdAt: recoveredAt,
      }),
    );
    harness.respondToUserInput.mockImplementation(() => Effect.void);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-retry-full-context"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-full-context"),
        answers: { continue: "Yes" },
        createdAt: recoveredAt,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 2);
    const retriedResponse = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "userInput",
        requestId: asApprovalRequestId("user-input-request-full-context"),
      }),
    );
    expect(Option.getOrUndefined(retriedResponse)).toMatchObject({
      status: "responding",
      responseCommandId: "cmd-user-input-retry-full-context",
    });
  });

  it.each([undefined, "generation-stale"])(
    "surfaces unclaimable responses (%s) without expiring the current generation",
    async (generation) => {
      const harness = await createHarness();
      const now = new Date().toISOString();

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-session-set-for-unclaimable"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe("cmd-user-input-requested-unclaimable"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          activity: {
            id: EventId.makeUnsafe("activity-user-input-requested-unclaimable"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId: "user-input-request-unclaimable",
              lifecycleGeneration: "generation-current",
              questions: [],
            },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        }),
      );

      // A response carrying a lifecycle generation the durable row does not have
      // can never claim it. This used to be dropped with no activity and no
      // resolution, leaving the prompt permanently stuck.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.makeUnsafe("cmd-user-input-respond-unclaimable"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          requestId: asApprovalRequestId("user-input-request-unclaimable"),
          ...(generation ? { lifecycleGeneration: generation } : {}),
          answers: { input: "continue" },
          createdAt: now,
        }),
      );

      await waitFor(
        async () =>
          (await readHarnessThread(harness))?.activities.some(
            (activity) => activity.kind === "provider.user-input.respond.failed",
          ) === true,
      );
      expect(harness.respondToUserInput).not.toHaveBeenCalled();

      const failureActivity = (await readHarnessThread(harness))?.activities.find(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
      expect(failureActivity?.payload).toMatchObject({
        requestId: "user-input-request-unclaimable",
        responseCommandId: "cmd-user-input-respond-unclaimable",
        settlementStatus: generation ? "uncertain" : "retryable",
        detail: expect.stringContaining(
          generation ? "Stale pending user-input request:" : "generation is missing",
        ),
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe("old-reconciliation"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          createdAt: now,
          activity: {
            id: EventId.makeUnsafe("old-reconciliation"),
            kind: "provider.user-input.respond.failed",
            tone: "error",
            summary: "Old callback expired",
            turnId: null,
            createdAt: now,
            payload: {
              requestId: "user-input-request-unclaimable",
              lifecycleGeneration: "generation-stale",
              detail: "Stale pending user-input request: user-input-request-unclaimable",
            },
          },
        }),
      );
      const outstanding = await Effect.runPromise(
        harness.pendingInteractionRepository.listUnsettled({
          threadId: ThreadId.makeUnsafe("thread-1"),
        }),
      );
      expect(outstanding).toEqual([
        expect.objectContaining({ lifecycleGeneration: "generation-current", status: "pending" }),
      ]);
    },
  );

  it("pauses a goal on explicit session stop during a Devin recovery gap", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "devin", model: "swe-1.7" },
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("goal-before-session-gap-stop"),
        threadId,
        goal: "Finish the work",
        goalStartBehavior: "defer",
      }),
    );
    // Recovery has already settled its old turn. No adapter terminal event remains.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("session-gap-before-stop"),
        threadId,
        session: {
          threadId,
          status: "interrupted",
          providerName: "devin",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("session-gap-user-stop"),
        threadId,
        createdAt: now,
      }),
    );
    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "stopped");
    expect((await readHarnessThread(harness))?.goalPausedAt).toBeTruthy();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("does not delete the resume cursor when stopRuntimeSession is unavailable", async () => {
    const harness = await createHarness({ omitStopRuntimeSession: true });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-missing-runtime-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-session-stop-missing-runtime-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.session?.status === "stopped" &&
        thread.activities.some((activity) => activity.kind === "provider.session.stop.failed")
      );
    });
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.status).toBe("stopped");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.session.stop.failed"),
    ).toMatchObject({
      summary: "Provider session stop failed",
      payload: {
        detail: "The cursor-preserving runtime stop is unavailable.",
      },
    });
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
  });

  it.each(["rejects", "times out"] as const)(
    "cancels deleted-thread queued work when computer cleanup %s",
    async (failure) => {
      const manager = new ComputerManager({ backend: new FakeComputerBackend() });
      const removed = vi
        .spyOn(manager, "handleThreadRemoved")
        .mockImplementationOnce(() =>
          failure === "rejects"
            ? Promise.reject(new Error("computer cleanup failed"))
            : new Promise<void>(() => {}),
        );
      try {
        const harness = await createHarness({
          commandEventTimeout: Duration.seconds(1),
          computerService: {
            supported: true,
            availability: { kind: "available", backend: "fake" },
            manager,
          },
        });
        const threadId = ThreadId.makeUnsafe("thread-healthy-after-cleanup-failure");
        const now = new Date().toISOString();
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-create-cleanup-failure"),
            threadId,
            projectId: asProjectId("project-1"),
            title: "Healthy thread",
            modelSelection: { provider: "codex", model: "gpt-5.4" },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: now,
          }),
        );
        const queuedSequence = await seedQueuedTurnBehindLiveTurn(harness, {
          liveTurnId: asTurnId("turn-before-cleanup-failure"),
          messageId: asMessageId("queued-before-cleanup-failure"),
          text: "Keep this queued until the current turn finishes",
        });
        const queuedBeforeDelete = await Effect.runPromise(
          harness.queuedTurnPromotionRepository.getBySequence(queuedSequence),
        );
        expect(queuedBeforeDelete.pipe(Option.getOrThrow).state).toBe("queued");
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.makeUnsafe("cmd-delete-cleanup-failure"),
            threadId: ThreadId.makeUnsafe("thread-1"),
          }),
        );
        await expect(harness.drain()).resolves.toBeUndefined();
        expect(removed).toHaveBeenCalledWith(ThreadId.makeUnsafe("thread-1"));
        const promotion = await Effect.runPromise(
          harness.queuedTurnPromotionRepository.getBySequence(queuedSequence),
        );
        expect(promotion.pipe(Option.getOrThrow).state).toBe("cancelled");
        await dispatchHarnessUserTurn(harness, {
          threadId,
          messageId: "healthy-after-cleanup-failure",
          text: "Continue",
          createdAt: now,
        });
        await harness.drain();
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn.mock.calls[0]?.[0].threadId).toBe(threadId);
      } finally {
        await manager.dispose();
      }
    },
  );

  it("serializes archive cleanup through the durable provider intent source", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-archive"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("cmd-archive-active-provider-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );

    await waitFor(async () => {
      if (harness.stopRuntimeSession.mock.calls.length !== 1) return false;
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.archivedAt !== null && thread?.session?.status === "stopped";
    });

    expect(harness.stopRuntimeSession).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(harness.stopSession).not.toHaveBeenCalled();
  });

  it("restores computer admission after ordered archive cleanup and before the next provider turn", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    const order: string[] = [];
    let finishArchive!: () => void;
    const archiveGate = new Promise<void>((resolve) => {
      finishArchive = resolve;
    });
    const remove = manager.handleThreadRemoved.bind(manager);
    vi.spyOn(manager, "handleThreadRemoved").mockImplementation(async (id) => {
      await remove(id);
      order.push("archive-held");
      await archiveGate;
      order.push("archive-finished");
    });
    const restore = manager.handleThreadRestored.bind(manager);
    const restored = vi.spyOn(manager, "handleThreadRestored").mockImplementation(async (id) => {
      await restore(id);
      order.push("restored");
    });
    try {
      const harness = await createHarness({
        computerService: {
          supported: true,
          availability: { kind: "available", backend: "fake" },
          manager,
        },
      });
      harness.sendTurn.mockImplementation(() =>
        Effect.sync(() => {
          order.push("sent");
          return { threadId, turnId: asTurnId("turn-after-computer-restore") };
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("cmd-computer-archive-held"),
          threadId,
        }),
      );
      await waitFor(() => order.includes("archive-held"));
      await expect(manager.withAgentActivity(threadId, async () => undefined)).rejects.toThrow(
        "revoked",
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.makeUnsafe("cmd-computer-unarchive-ordered"),
          threadId,
        }),
      );
      await dispatchHarnessUserTurn(harness, {
        messageId: "user-after-computer-restore",
        text: "Continue after unarchive",
        createdAt: new Date().toISOString(),
      });
      expect(restored).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      finishArchive();
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(order).toEqual(["archive-held", "archive-finished", "restored", "sent"]);
      await expect(manager.withAgentActivity(threadId, async () => "allowed")).resolves.toBe(
        "allowed",
      );
    } finally {
      finishArchive();
      await manager.dispose();
    }
  });

  it("does not restore pending sidechat context after an explicit session stop", async () => {
    const threadId = ThreadId.makeUnsafe("thread-stopped-droid-sidechat");
    const harness = await createHarness({
      forkThreadResult: {
        threadId,
        resumeCursor: { sessionId: "stopped-droid-sidechat" },
      },
    });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-stopped-droid-sidechat-create"),
        threadId,
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        sidechatSourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Stopped Droid sidechat",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("stopped-droid-sidechat-imported-user"),
            role: "user",
            text: "Context cleared by stop",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-stopped-droid-sidechat-overlong"),
        threadId,
        message: {
          messageId: asMessageId("stopped-droid-sidechat-overlong-user"),
          role: "user",
          text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 100),
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((thread) => thread.id === threadId)?.session?.status === "error"
      );
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-stopped-droid-sidechat-stop"),
        threadId,
        createdAt: now,
      }),
    );
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        harness.stopRuntimeSession.mock.calls.length === 1 &&
        readModel.threads.find((thread) => thread.id === threadId)?.session?.status === "stopped"
      );
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-stopped-droid-sidechat-fresh-turn"),
        threadId,
        message: {
          messageId: asMessageId("stopped-droid-sidechat-fresh-user"),
          role: "user",
          text: "Start fresh after stop",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    // Explicit stop keeps the provider binding: only the runtime is stopped.
    expect(harness.stopSession).not.toHaveBeenCalled();
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).not.toContain("<sidechat_context>");
    expect(input?.input).not.toContain("<thread_context>");
    expect(input?.input).not.toContain("Context cleared by stop");
    expect(input?.input).toContain("Start fresh after stop");
  });

  it("routes subagent interrupts through the parent provider session using the child provider thread id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-parent"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-parent"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-subagent"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        projectId: asProjectId("project-1"),
        title: "Halley [explorer]",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-subagent"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        session: {
          threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-child"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-subagent"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-child",
      providerThreadId: "child-provider-1",
      controlRequestId: "command:cmd-turn-interrupt-subagent",
      expectedLifecycleGeneration: null,
    });
  });

  it("routes subagent interrupts even when the child thread has no session of its own", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-parent-sessionless"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-subagent-sessionless"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-2"),
        projectId: asProjectId("project-1"),
        title: "Halley [explorer]",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-subagent-sessionless"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-2"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      providerThreadId: "child-provider-2",
      controlRequestId: "command:cmd-turn-interrupt-subagent-sessionless",
      expectedLifecycleGeneration: null,
    });
  });

  it("interrupts active subagent sessions without stopping the parent provider session", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-parent-for-child-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-subagent-for-stop"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        projectId: asProjectId("project-1"),
        title: "Agent",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-subagent-for-stop"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        session: {
          threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-child-stop"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-session-stop-subagent"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-child-stop",
      providerThreadId: "child-provider-1",
    });

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === "subagent:thread-1:child-provider-1",
      );
      return (
        thread?.session?.status === "interrupted" &&
        thread.session.activeTurnId === "turn-child-stop"
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find(
      (entry) => entry.id === "subagent:thread-1:child-provider-1",
    );
    expect(thread?.session?.status).toBe("interrupted");
    expect(thread?.session?.activeTurnId).toBe("turn-child-stop");
  });

  it("defers a runtime-mode change while a turn is active instead of restarting the session", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-mode-session-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-mode-active"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    const midTurn = await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-mode-set-mid-turn"),
        threadId,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await waitFor(async () => {
      const state = await Effect.runPromise(
        harness.deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER),
      );
      return state.pipe(Option.getOrThrow).lastAckedSequence >= midTurn.sequence;
    });
    const changedThread = await readHarnessThread(harness);
    expect(changedThread?.runtimeMode).toBe("full-access");
    expect(changedThread?.session?.runtimeMode).toBe("approval-required");
    expect(changedThread?.session?.activeTurnId).toBe("turn-mode-active");
    // The in-flight turn must survive the mode change: ensuring the session
    // now would restart the provider and kill the running turn.
    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-mode-session-settled"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    const settled = await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-mode-set-settled"),
        threadId,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(async () => {
      const state = await Effect.runPromise(
        harness.deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER),
      );
      return state.pipe(Option.getOrThrow).lastAckedSequence >= settled.sequence;
    });
    // Settling the turn does not make permission selection start a session.
    // The desired mode waits for the next turn in both cases.
    expect(harness.startSession.mock.calls.length).toBe(0);
    expect((await readHarnessThread(harness))?.runtimeMode).toBe("approval-required");
    expect((await readHarnessThread(harness))?.session?.runtimeMode).toBe("full-access");
  });
});
