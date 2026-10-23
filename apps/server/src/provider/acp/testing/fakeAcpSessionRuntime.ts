// FILE: fakeAcpSessionRuntime.ts
// Purpose: Shared test fake for AcpSessionRuntimeShape — an idle ACP session that starts,
//          reports a full-access mode, and answers prompts with `end_turn` by default.
// Layer: Server test utility (imported by *.test.ts only; never by production code)

import type * as Acp from "@agentclientprotocol/sdk";
import { Effect, Stream } from "effect";

import type { AcpSessionRuntimeShape } from "../AcpSessionRuntime.ts";

export function makeFakeAcpSessionRuntime(
  options: {
    readonly sessionId?: string;
    readonly prompt?: AcpSessionRuntimeShape["prompt"];
  } = {},
): AcpSessionRuntimeShape {
  const registerHandler = () => Effect.void;
  return {
    handleRequestPermission: registerHandler,
    handleElicitation: registerHandler,
    handleReadTextFile: registerHandler,
    handleWriteTextFile: registerHandler,
    handleCreateTerminal: registerHandler,
    handleTerminalOutput: registerHandler,
    handleTerminalWaitForExit: registerHandler,
    handleTerminalKill: registerHandler,
    handleTerminalRelease: registerHandler,
    handleSessionUpdate: registerHandler,
    handleElicitationComplete: registerHandler,
    handleExtRequest: registerHandler,
    handleExtNotification: registerHandler,
    start: () =>
      Effect.succeed({
        sessionId: options.sessionId ?? "acp-test-session",
        initializeResult: {} as Acp.InitializeResponse,
        sessionSetupResult: {} as Acp.NewSessionResponse,
        modelConfigId: undefined,
        sessionSetupMethod: "new",
      }),
    awaitExit: Effect.never,
    getEvents: () => Stream.never,
    sessionUpdatesEnqueuedCount: Effect.succeed(0),
    supportsSessionFork: Effect.succeed(false),
    supportsSessionRecovery: Effect.succeed(true),
    getModeState: Effect.succeed({
      currentModeId: "bypass",
      availableModes: [{ id: "bypass", name: "Full Access" }],
    }),
    getSessionEpoch: () => Effect.succeed(0 as never),
    getPendingSessionNotificationCount: () => Effect.succeed(0),
    getConfigOptions: Effect.succeed([]),
    getAvailableCommands: Effect.succeed([]),
    awaitLoadReplayReady: Effect.void,
    prompt:
      options.prompt ?? (() => Effect.succeed({ stopReason: "end_turn" } as Acp.PromptResponse)),
    cancel: Effect.void,
    setMode: () => Effect.succeed({} as Acp.SetSessionModeResponse),
    setConfigOption: () => Effect.succeed({} as Acp.SetSessionConfigOptionResponse),
    setModel: () => Effect.void,
    forkSession: () => Effect.succeed({} as Acp.ForkSessionResponse),
    request: () => Effect.succeed({}),
    notify: () => Effect.void,
  } as AcpSessionRuntimeShape;
}
