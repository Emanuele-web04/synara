import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeRunningChatsQuitGuard,
  parseQuitConfirmationReference,
  parseQuitConfirmationResponse,
  shouldPromptForRunningChatsBeforeQuit,
} from "./runningChatsQuitGuard";

describe("running chats quit guard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prompts only for user-initiated window close and before-quit", () => {
    expect(shouldPromptForRunningChatsBeforeQuit("window-close")).toBe(true);
    expect(shouldPromptForRunningChatsBeforeQuit("before-quit")).toBe(true);
    expect(shouldPromptForRunningChatsBeforeQuit("SIGINT")).toBe(false);
    expect(shouldPromptForRunningChatsBeforeQuit("fatal startup (bootstrap)")).toBe(false);
    expect(shouldPromptForRunningChatsBeforeQuit("custom-title-bar-relaunch")).toBe(false);
  });

  it("parses quit requests", () => {
    expect(parseQuitConfirmationReference(null)).toBeNull();
    expect(parseQuitConfirmationReference({ requestId: " " })).toBeNull();
    expect(parseQuitConfirmationReference({ requestId: "q1" })).toEqual({ requestId: "q1" });
  });

  it("rejects malformed renderer replies and parses the two phases", () => {
    expect(parseQuitConfirmationResponse(null)).toBeNull();
    expect(parseQuitConfirmationResponse({ phase: "decision", allow: true })).toBeNull();
    expect(parseQuitConfirmationResponse({ requestId: "q1", phase: "ready" })).toEqual({
      requestId: "q1",
      phase: "ready",
    });
    expect(
      parseQuitConfirmationResponse({ requestId: "q1", phase: "decision", allow: true }),
    ).toEqual({ requestId: "q1", phase: "decision", allow: true });
  });

  it("allows quit immediately when the renderer is unavailable", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const send = vi.fn();

    await expect(
      guard.askRenderer({
        send,
        isRendererAvailable: () => false,
      }),
    ).resolves.toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("waits for an explicit decision even when no chats are running", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const send = vi.fn();
    const decision = guard.askRenderer({
      send,
      isRendererAvailable: () => true,
    });

    expect(send).toHaveBeenCalledWith({ requestId: "q1" });
    guard.receiveResponse({ requestId: "q1", phase: "ready" });
    expect(guard.hasPendingAsk()).toBe(true);
    expect(guard.hasAllowedQuit()).toBe(false);
    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: true });
    await expect(decision).resolves.toBe(true);
    expect(guard.hasAllowedQuit()).toBe(true);
  });

  it("stays when the user declines, then can prompt again", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const first = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready" });
    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: false });
    await expect(first).resolves.toBe(false);
    expect(guard.hasAllowedQuit()).toBe(false);

    const second = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
    });
    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: true });
    await expect(second).resolves.toBe(true);
  });

  it("coalesces overlapping quit asks onto one renderer request", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const send = vi.fn();
    const first = guard.askRenderer({
      send,
      isRendererAvailable: () => true,
    });
    const second = guard.askRenderer({
      send,
      isRendererAvailable: () => true,
    });

    expect(send).toHaveBeenCalledOnce();
    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: false });
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });

  it("fails open if the renderer never acknowledges the request", async () => {
    vi.useFakeTimers();
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      timeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);
    await expect(decision).resolves.toBe(true);
  });

  it("does not time out after the renderer says chats are running", async () => {
    vi.useFakeTimers();
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      timeoutMs: 50,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready" });

    await vi.advanceTimersByTimeAsync(200);
    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: false });
    await expect(decision).resolves.toBe(false);
  });

  it("allows a pending ask when the renderer dies mid-confirmation, without latching", async () => {
    const requestIds = ["q1", "q2"];
    const guard = makeRunningChatsQuitGuard(() => requestIds.shift() ?? "unexpected");
    const first = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
    });
    expect(guard.hasPendingAsk()).toBe(true);

    // The renderer hosting the ask is gone — the quit it was part of must
    // proceed, but no user said yes, so the allowed latch must not set.
    guard.allowPending();

    await expect(first).resolves.toBe(true);
    expect(guard.hasPendingAsk()).toBe(false);
    expect(guard.hasAllowedQuit()).toBe(false);

    const send = vi.fn();
    const second = guard.askRenderer({ send, isRendererAvailable: () => true });
    expect(send).toHaveBeenCalledWith({ requestId: "q2" });
    guard.receiveResponse({ requestId: "q2", phase: "decision", allow: true });
    await expect(second).resolves.toBe(true);
  });

  it("cancels a pending decision when the renderer is replaced and can prompt again", async () => {
    const requestIds = ["q1", "q2"];
    const guard = makeRunningChatsQuitGuard(() => requestIds.shift() ?? "unexpected");
    const first = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready" });

    guard.cancelPending();

    await expect(first).resolves.toBe(false);
    const send = vi.fn();
    const second = guard.askRenderer({ send, isRendererAvailable: () => true });
    expect(send).toHaveBeenCalledWith({ requestId: "q2" });
    guard.receiveResponse({ requestId: "q2", phase: "decision", allow: true });
    await expect(second).resolves.toBe(true);
  });

  it("calls onReady once when the page acknowledges the question", async () => {
    const onReady = vi.fn();
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({ send: vi.fn(), isRendererAvailable: () => true, onReady });

    expect(onReady).not.toHaveBeenCalled();

    guard.receiveResponse({ requestId: "q1", phase: "ready" });
    expect(onReady).toHaveBeenCalledTimes(1);

    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: false });
    await expect(decision).resolves.toBe(false);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("asks the page to answer a repeated quit", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({ send: vi.fn(), isRendererAvailable: () => true });
    guard.receiveResponse({ requestId: "q1", phase: "ready" });

    const notify = vi.fn();
    guard.repeatQuit(notify);
    expect(notify).toHaveBeenCalledWith("q1");

    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: true });
    await expect(decision).resolves.toBe(true);
  });

  it("arms a repeat that arrives before the page acknowledged it", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({ send: vi.fn(), isRendererAvailable: () => true });
    const notify = vi.fn();

    guard.repeatQuit(notify);
    expect(notify).not.toHaveBeenCalled();

    guard.receiveResponse({ requestId: "q1", phase: "ready" });
    expect(notify).toHaveBeenCalledWith("q1");

    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: true });
    await expect(decision).resolves.toBe(true);
  });

  it("forces a repeated quit when the page never answers it", async () => {
    vi.useFakeTimers();
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      timeoutMs: 20,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready" });

    guard.repeatQuit(vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    await expect(decision).resolves.toBe(true);
    expect(guard.hasAllowedQuit()).toBe(true);
  });

  it("tells the page to take down a question the app stopped waiting on", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const withdraw = vi.fn();
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      withdraw,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready" });

    guard.cancelPending();

    await expect(decision).resolves.toBe(false);
    expect(withdraw).toHaveBeenCalledWith("q1");
  });

  it("quits a committed ask the page never answers", async () => {
    vi.useFakeTimers();
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      timeoutMs: 50,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready" });

    expect(guard.beginCommit("q1")).toBe(true);
    await vi.advanceTimersByTimeAsync(50);

    await expect(decision).resolves.toBe(true);
    expect(guard.hasAllowedQuit()).toBe(true);
  });

  it("does not cancel or withdraw a committed ask", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const withdraw = vi.fn();
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      withdraw,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready" });
    let settled: boolean | null = null;
    void decision.then((allow) => {
      settled = allow;
    });

    expect(guard.beginCommit("q2")).toBe(false);
    expect(guard.beginCommit("q1")).toBe(true);
    guard.cancelPending();
    await Promise.resolve();

    expect(settled).toBeNull();
    expect(withdraw).not.toHaveBeenCalled();
    expect(guard.hasPendingAsk()).toBe(true);

    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: true });
    await expect(decision).resolves.toBe(true);
    expect(guard.hasAllowedQuit()).toBe(true);
  });

  it("ignores a denial after the commit", async () => {
    vi.useFakeTimers();
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      timeoutMs: 20,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready" });
    expect(guard.beginCommit("q1")).toBe(true);
    let settled: boolean | null = null;
    void decision.then((allow) => {
      settled = allow;
    });

    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: false });
    await Promise.resolve();

    expect(settled).toBeNull();
    expect(guard.hasAllowedQuit()).toBe(false);

    await vi.advanceTimersByTimeAsync(50);

    await expect(decision).resolves.toBe(true);
    expect(guard.hasAllowedQuit()).toBe(true);
  });
});
