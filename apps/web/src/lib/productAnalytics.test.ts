import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ORCHESTRATION_WS_METHODS, WS_METHODS, type OrchestrationEvent } from "@synara/contracts";
import {
  ProductTurnObserver,
  productRpcActivity,
  trackProductNavigation,
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
