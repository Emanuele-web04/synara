import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ORCHESTRATION_WS_METHODS, WS_METHODS, type OrchestrationEvent } from "@synara/contracts";
import {
  ProductTurnObserver,
  productRpcActivity,
  productTurnFailure,
  trackProductNavigation,
  trackShortcutCommand,
  trackSlashCommand,
} from "./productAnalytics";

const track = vi.fn();
const getState = vi.fn(async () => ({ enabled: true }));
beforeEach(() => {
  vi.stubGlobal("window", { desktopBridge: { productAnalytics: { track, getState } } });
  track.mockClear();
  getState.mockResolvedValue({ enabled: true });
});
afterEach(() => vi.unstubAllGlobals());

function completed(overrides: Record<string, unknown> = {}): OrchestrationEvent {
  return {
    type: "thread.activity-appended",
    payload: {
      threadId: "private-thread",
      activity: {
        id: "private-event",
        turnId: "private-turn",
        kind: "turn.completed",
        createdAt: new Date().toISOString(),
        summary: "Private output",
        payload: {
          state: "completed",
          provider: "claudeAgent",
          modelUsage: {
            "private-custom-model": { inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 5 },
          },
          errorMessage: "secret",
        },
        ...overrides,
      },
    },
  } as unknown as OrchestrationEvent;
}

it("counts a live completed turn once without exporting content or identifiers", async () => {
  const observer = new ProductTurnObserver();
  observer.observe(completed(), "remote");
  observer.observe(completed(), "remote");
  await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1));
  expect(track.mock.calls[0]![0]).toEqual({
    event: "turn.completed",
    outcome: "succeeded",
    mode: "remote",
    provider: "claude",
    inputTokens: 20,
    outputTokens: 10,
    cachedInputTokens: 5,
  });
});

it("ignores old history, disabled consent and unknown terminal states", async () => {
  const observer = new ProductTurnObserver();
  observer.observe(completed({ createdAt: "2000-01-01T00:00:00.000Z" }), "local");
  observer.observe(completed({ payload: { state: "running" } }), "local");
  await Promise.resolve();
  getState.mockResolvedValue({ enabled: false });
  observer.observe(completed(), "local");
  await Promise.resolve();
  expect(track).not.toHaveBeenCalled();
});

it("reports cancellation and leaves missing token usage unknown instead of zero", async () => {
  const observer = new ProductTurnObserver();
  observer.observe(completed({ payload: { state: "interrupted" } }), "local");
  await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1));
  expect(track.mock.calls[0]![0]).toEqual({
    event: "turn.completed",
    outcome: "cancelled",
    mode: "local",
    provider: "other",
  });
});

it("reports a failed turn's fixed category and HTTP status, never its error text", async () => {
  const observer = new ProductTurnObserver();
  observer.observe(
    completed({
      payload: {
        state: "failed",
        provider: "claudeAgent",
        errorCode: "edge_blocked",
        httpStatus: 403,
        errorMessage: "secret path /Users/private/project",
      },
    }),
    "local",
  );
  await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1));
  expect(track.mock.calls[0]![0]).toEqual({
    event: "turn.completed",
    outcome: "failed",
    mode: "local",
    provider: "claude",
    failure: "edge_blocked",
    httpStatus: 403,
  });
});

it("maps provider error codes to fixed turn failure categories", () => {
  const failure = (errorCode: unknown, httpStatus?: number, outcome = "failed" as const) =>
    productTurnFailure({ outcome, errorCode, httpStatus });
  expect(failure("edge_blocked", 403)).toBe("edge_blocked");
  expect(failure("authentication_failed", 401)).toBe("auth");
  expect(failure("unauthorized")).toBe("auth");
  expect(failure("usageLimitExceeded")).toBe("usage_limit");
  expect(failure("responseStreamDisconnected")).toBe("network");
  expect(failure("custom-provider-code", 503)).toBe("server_error");
  expect(failure(undefined)).toBe("other");
  // A cancelled turn without an error is a user stop, not a failure.
  expect(
    productTurnFailure({ outcome: "cancelled", errorCode: undefined, httpStatus: undefined }),
  ).toBeUndefined();
  expect(
    productTurnFailure({ outcome: "cancelled", errorCode: "edge_blocked", httpStatus: 403 }),
  ).toBe("edge_blocked");
});

it("classifies only explicit actions and fixed navigation categories", () => {
  expect(
    productRpcActivity(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command: { type: "thread.turn.start", message: "secret", threadId: "private" },
    }),
  ).toEqual({ event: "chat.request" });
  expect(
    productRpcActivity(WS_METHODS.hostsRemoteAccess, {
      request: { operation: "pair", secret: "private" },
    }),
  ).toEqual({ event: "connection.pair" });
  expect(productRpcActivity(WS_METHODS.hostsList, {})).toBeUndefined();
  trackProductNavigation("/inbox/private-title");
  trackProductNavigation("/private-thread");
  expect(track).toHaveBeenCalledExactlyOnceWith({
    event: "feature.used",
    outcome: "succeeded",
    feature: "inbox",
  });
});

it("reports built-in command names only and counts one key press once", () => {
  track.mockClear();
  const press = {};
  trackShortcutCommand(press, "terminal.toggle");
  trackShortcutCommand(press, "terminal.toggle");
  trackShortcutCommand({}, "thread.jump.3");
  trackShortcutCommand({}, "script.run:deploy-prod");
  trackSlashCommand("/Plan");
  trackSlashCommand("my-team-skill");
  expect(track.mock.calls.map(([input]) => input.command)).toEqual([
    "shortcut:terminal.toggle",
    "shortcut:thread.jump",
    "shortcut:custom",
    "slash:plan",
    "slash:custom",
  ]);
});
