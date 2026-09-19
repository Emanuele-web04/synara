/**
 * WebSocket handlers for the computer RPC group: status and setup, perception
 * for the pane, thread state, and the pane's own input. The agent never acts
 * through this surface; its actions are MCP tools on the agent gateway.
 */
import {
  COMPUTER_WS_METHODS,
  type ComputerActionResult,
  type ComputerGetStateInput,
  type ComputerGetStatusInput,
  type ComputerInputClickInput,
  type ComputerInputKeyInput,
  type ComputerInputScrollInput,
  type ComputerProvisionInput,
  type ComputerProvisionResult,
  type ComputerState,
  type ComputerStatusResult,
  type ComputerThreadInput,
  type ThreadComputerState,
  WsRpcError,
} from "@synara/contracts";
import { Effect } from "effect";

import { NO_COMPUTER_CAPABILITIES } from "./ComputerBackend.ts";
import type { ComputerManager } from "./ComputerManager.ts";
import type { ComputerServiceShape } from "./Services/ComputerService.ts";

/**
 * Shown only when no computer service started at all, so it cannot name the
 * missing piece the way a live backend's `availability()` does — a backend that
 * exists always reports its own reason, and this is the case where there is no
 * backend to ask. It therefore names the requirement every tier shares rather
 * than any one tier's dependencies.
 */
const UNSUPPORTED_MESSAGE = "No computer backend is available on this server.";

function unsupported<A>(): Effect.Effect<A, WsRpcError> {
  return Effect.fail(new WsRpcError({ message: UNSUPPORTED_MESSAGE }));
}

function attempt<A>(
  promise: () => Promise<A>,
  fallbackMessage: string,
): Effect.Effect<A, WsRpcError> {
  return Effect.tryPromise({
    try: promise,
    catch: (cause) =>
      new WsRpcError({
        message: cause instanceof Error && cause.message ? cause.message : fallbackMessage,
      }),
  });
}

export interface WsComputerHandlers {
  readonly [COMPUTER_WS_METHODS.getStatus]: (
    input: ComputerGetStatusInput,
  ) => Effect.Effect<ComputerStatusResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.provision]: (
    input: ComputerProvisionInput,
  ) => Effect.Effect<ComputerProvisionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.getState]: (
    input: ComputerGetStateInput,
  ) => Effect.Effect<ComputerState, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.getThreadState]: (
    input: ComputerThreadInput,
  ) => Effect.Effect<ThreadComputerState, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.inputClick]: (
    input: ComputerInputClickInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.inputScroll]: (
    input: ComputerInputScrollInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.inputKey]: (
    input: ComputerInputKeyInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
}

export function makeWsComputerHandlers(
  computerService: ComputerServiceShape | undefined,
): WsComputerHandlers {
  if (!computerService?.supported) {
    const unsupportedStatus = {
      computerId: computerService?.manager.computerId ?? "desktop",
      availability: computerService?.availability ?? {
        kind: "backend-unavailable" as const,
        message: UNSUPPORTED_MESSAGE,
      },
      // Nothing supervises a backend that was never started, so the health
      // of one is permanently the boot-time verdict.
      health: {
        status: "unavailable" as const,
        consecutiveFailures: 0,
        reconnects: 0,
        captureAvailable: false,
      },
      // A backend that was never started can do nothing, and saying so is
      // what keeps the panel's badges and the tool descriptions from
      // advertising a desktop this host has not got.
      capabilities: NO_COMPUTER_CAPABILITIES,
      provisionable: false,
    } satisfies ComputerStatusResult;
    const unsupportedState = (input: ComputerThreadInput) =>
      attempt(async () => {
        return {
          ...unsupportedStatus,
          threadId: input.threadId,
          version: 0,
          windows: [],
          screenSize: { width: 1, height: 1 },
          agentActive: false,
          controlledByOtherThread: false,
          lastError: null,
        } satisfies ThreadComputerState;
      }, "Failed to read computer availability");
    return {
      [COMPUTER_WS_METHODS.getStatus]: () => Effect.succeed(unsupportedStatus),
      [COMPUTER_WS_METHODS.provision]: () => unsupported(),
      [COMPUTER_WS_METHODS.getState]: () => unsupported(),
      [COMPUTER_WS_METHODS.getThreadState]: unsupportedState,
      [COMPUTER_WS_METHODS.inputClick]: () => unsupported(),
      [COMPUTER_WS_METHODS.inputScroll]: () => unsupported(),
      [COMPUTER_WS_METHODS.inputKey]: () => unsupported(),
    };
  }

  const manager = computerService.manager;
  return {
    [COMPUTER_WS_METHODS.getStatus]: (input) =>
      attempt(
        () => manager.getStatus(input.engage === true ? { engage: true } : {}),
        "Failed to read computer status",
      ),
    [COMPUTER_WS_METHODS.provision]: () =>
      attempt(() => manager.provision(), "Failed to set up computer control"),
    [COMPUTER_WS_METHODS.getState]: (input) =>
      attempt(
        () =>
          manager.getState({
            ...(input.includeScreenshot !== undefined
              ? { includeScreenshot: input.includeScreenshot }
              : {}),
            ...(input.includeText !== undefined ? { includeText: input.includeText } : {}),
            ...(input.windowId !== undefined ? { windowId: input.windowId } : {}),
          }),
        "Failed to read computer perception state",
      ),
    [COMPUTER_WS_METHODS.getThreadState]: (input) =>
      attempt(() => manager.getThreadState(input.threadId), "Failed to read computer state"),
    [COMPUTER_WS_METHODS.inputClick]: (input) =>
      attempt(() => userInputClick(manager, input), "Failed to click on computer"),
    [COMPUTER_WS_METHODS.inputScroll]: (input) =>
      attempt(
        () => manager.scroll(undefined, { x: input.x, y: input.y }, input.deltaX, input.deltaY),
        "Failed to scroll on computer",
      ),
    [COMPUTER_WS_METHODS.inputKey]: (input) =>
      attempt(() => userInputKey(manager, input), "Failed to press computer key"),
  };
}

/**
 * A pane click carries a resolved desktop point, so it goes straight to the
 * coordinate path of the manager — no AT-SPI tree read, no semantic matching.
 */
function userInputClick(
  manager: ComputerManager,
  input: ComputerInputClickInput,
): Promise<ComputerActionResult> {
  const target = { x: input.x, y: input.y };
  if (input.button === "right") return manager.rightClick(undefined, target);
  return (input.clickCount ?? 1) >= 2
    ? manager.doubleClick(undefined, target)
    : manager.click(undefined, target);
}

function userInputKey(
  manager: ComputerManager,
  input: ComputerInputKeyInput,
): Promise<ComputerActionResult> {
  // A repeated modifier would be pressed twice and released twice, which reads
  // as a tap of that modifier on the way out of the chord.
  const modifiers = [...new Set(input.modifiers ?? [])];
  return modifiers.length === 0
    ? manager.pressKey(undefined, input.key)
    : manager.hotkey(undefined, [...modifiers, input.key]);
}
