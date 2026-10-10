import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitWsTransportState } from "../wsTransportEvents";
import { subscribeComposerTransportStatus } from "./composerTransportStatus";

describe("composer transport status", () => {
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    emitWsTransportState("open");
  });

  afterEach(() => {
    unsubscribe?.();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["connecting", "closed"] as const)("delays %s by 1.5 seconds", (state) => {
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value));
    emitWsTransportState(state);
    vi.advanceTimersByTime(1499);
    expect(message).toBeNull();
    vi.advanceTimersByTime(1);
    expect(message).toBe("Reconnecting to Synara…");
    emitWsTransportState("open");
    expect(message).toBeNull();
  });

  it("does not restart the delay as reconnect attempts cycle between closed and connecting", () => {
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value));
    emitWsTransportState("closed");
    vi.advanceTimersByTime(1000);
    emitWsTransportState("connecting");
    vi.advanceTimersByTime(500);
    expect(message).toBe("Reconnecting to Synara…");
  });

  it("cancels brief blips and starts a fresh delay for the next outage", () => {
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value));
    emitWsTransportState("connecting");
    vi.advanceTimersByTime(1400);
    emitWsTransportState("open");
    vi.advanceTimersByTime(200);
    expect(message).toBeNull();
    emitWsTransportState("closed");
    vi.advanceTimersByTime(1499);
    expect(message).toBeNull();
    vi.advanceTimersByTime(1);
    expect(message).toBe("Reconnecting to Synara…");
  });

  it.each([
    ["incompatible", "Synara connection is incompatible."],
    ["disposed", "Disconnected from Synara."],
  ] as const)("does not promise reconnection for %s", (state, expected) => {
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value));
    emitWsTransportState("connecting");
    vi.advanceTimersByTime(1500);
    emitWsTransportState(state);
    expect(message).toBe(expected);
  });

  it("replays an existing outage and cancels the timer and listener on unmount", () => {
    emitWsTransportState("closed");
    const messages: (string | null)[] = [];
    unsubscribe = subscribeComposerTransportStatus((value) => messages.push(value));
    vi.advanceTimersByTime(1500);
    expect(messages).toEqual(["Reconnecting to Synara…"]);
    emitWsTransportState("open");
    emitWsTransportState("closed");
    unsubscribe();
    vi.advanceTimersByTime(2000);
    emitWsTransportState("open");
    expect(messages).toEqual(["Reconnecting to Synara…", null]);
  });
});
