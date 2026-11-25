import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeRunningChatsQuitGuard,
  parseQuitConfirmationReference,
  parseQuitConfirmationRequest,
  parseQuitConfirmationResponse,
  quitConfirmationPresentationForPlatform,
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

  it("uses the in-app dialog on every desktop platform", () => {
    expect(quitConfirmationPresentationForPlatform()).toBe("in-app");
  });

  it("parses quit requests and defaults unknown presentation to in-app", () => {
    expect(parseQuitConfirmationRequest(null)).toBeNull();
    expect(parseQuitConfirmationRequest({ requestId: "q1", presentation: "native" })).toEqual({
      requestId: "q1",
      presentation: "native",
    });
    expect(parseQuitConfirmationRequest({ requestId: "q1" })).toEqual({
      requestId: "q1",
      presentation: "in-app",
    });
  });

  it("rejects malformed renderer replies", () => {
    expect(parseQuitConfirmationResponse(null)).toBeNull();
    expect(parseQuitConfirmationResponse({ phase: "decision", allow: true })).toBeNull();
    expect(
      parseQuitConfirmationResponse({ requestId: "q1", phase: "ready", runningCount: "2" }),
    ).toBeNull();
  });

  it("parses ready replies with the running chat list", () => {
    expect(
      parseQuitConfirmationResponse({
        requestId: "q1",
        phase: "ready",
        runningCount: 1,
        chats: [{ id: "a", title: "Fix the tray" }, { id: 2 }],
      }),
    ).toEqual({
      requestId: "q1",
      phase: "ready",
      runningCount: 1,
      chats: [{ id: "a", title: "Fix the tray" }],
    });
  });

  it("parses a reference that names the question", () => {
    expect(parseQuitConfirmationReference({ requestId: "q1" })).toEqual({ requestId: "q1" });
    expect(parseQuitConfirmationReference({ requestId: "  " })).toBeNull();
    expect(parseQuitConfirmationReference(null)).toBeNull();
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

    expect(send).toHaveBeenCalledWith({ requestId: "q1", presentation: "in-app" });
    guard.receiveResponse({ requestId: "q1", phase: "ready", runningCount: 0, chats: [] });
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
    guard.receiveResponse({ requestId: "q1", phase: "ready", runningCount: 2 });
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

  it("quits when the page never acknowledges the question", async () => {
    vi.useFakeTimers();
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      answerTimeoutMs: 50,
    });

    // A page that cannot show the question must not trap the app for a minute.
    await vi.advanceTimersByTimeAsync(50);
    await expect(decision).resolves.toBe(true);
    expect(guard.hasPendingAsk()).toBe(false);
  });

  it("withdraws the question and stays running after a silent answer", async () => {
    vi.useFakeTimers();
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const withdraw = vi.fn();
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      answerTimeoutMs: 50,
      withdraw,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready", runningCount: 1 });

    await vi.advanceTimersByTimeAsync(50);
    await expect(decision).resolves.toBe(false);
    expect(withdraw).toHaveBeenCalledWith("q1");
  });

  it("pauses the answer deadline after main accepts the answer", async () => {
    vi.useFakeTimers();
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      answerTimeoutMs: 50,
      preparationTimeoutMs: 200,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready", runningCount: 1 });
    expect(guard.beginPreparation("q1")).toBe(true);
    expect(guard.hasPendingAsk()).toBe(true);
    expect(guard.isPreparingQuit()).toBe(true);
    // A crash during preparation waits for the bounded prep timer.
    expect(guard.rendererGone()).toBe(false);

    // The old answer deadline must not cancel a user who just chose Quit.
    await vi.advanceTimersByTimeAsync(60);
    expect(guard.hasPendingAsk()).toBe(true);

    // Preparation has its own short bound so a hung server cannot strand quit.
    await vi.advanceTimersByTimeAsync(200);
    await expect(decision).resolves.toBe(true);
    expect(guard.isPendingRequest("q1")).toBe(false);
  });

  it("does not accept an answer before the question is ready", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
    });

    expect(guard.beginPreparation("q1")).toBe(false);
    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: true });
    await expect(decision).resolves.toBe(true);
  });

  it("asks the page to answer on a repeated quit, only while ready", async () => {
    vi.useFakeTimers();
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const notify = vi.fn();
    const withdraw = vi.fn();
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      preparationTimeoutMs: 200,
      withdraw,
    });

    // Not before the page has shown the question.
    expect(guard.repeatQuit(notify)).toBe(false);
    guard.receiveResponse({ requestId: "q1", phase: "ready", runningCount: 1 });
    expect(guard.repeatQuit(notify)).toBe(true);
    expect(notify).toHaveBeenCalledWith("q1");

    // A second repeat is ignored while the page answers.
    expect(guard.repeatQuit(notify)).toBe(false);

    // If the page never answers the repeat, the question is withdrawn and
    // the app stays running; the next ⌘Q starts a fresh question.
    await vi.advanceTimersByTimeAsync(200);
    await expect(decision).resolves.toBe(false);
    expect(withdraw).toHaveBeenCalledWith("q1");
  });

  it("does not repeat a question that already expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const notify = vi.fn();
    const withdraw = vi.fn();
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      answerTimeoutMs: 50,
      withdraw,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready", runningCount: 1 });

    vi.setSystemTime(1_051);
    expect(guard.repeatQuit(notify)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(withdraw).toHaveBeenCalledWith("q1");
    await expect(decision).resolves.toBe(false);
  });

  it("rejects an answer past the deadline before the timer callback runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      answerTimeoutMs: 50,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready", runningCount: 1 });

    // The IPC message is handled before the timer callback, but its clock is late.
    vi.setSystemTime(1_051);
    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: true });

    await expect(decision).resolves.toBe(false);
  });

  it("quits when the first ready reply arrives past the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      answerTimeoutMs: 50,
    });

    // No ready before the deadline means the page could not show the question.
    vi.setSystemTime(1_051);
    guard.receiveResponse({ requestId: "q1", phase: "ready", runningCount: 1 });

    await expect(decision).resolves.toBe(true);
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
    expect(guard.allowPending()).toBe(true);

    await expect(first).resolves.toBe(true);
    expect(guard.hasPendingAsk()).toBe(false);
    expect(guard.hasAllowedQuit()).toBe(false);

    const send = vi.fn();
    const second = guard.askRenderer({ send, isRendererAvailable: () => true });
    expect(send).toHaveBeenCalledWith({ requestId: "q2", presentation: "in-app" });
    guard.receiveResponse({ requestId: "q2", phase: "decision", allow: true });
    await expect(second).resolves.toBe(true);
  });

  it("does not allow a dead renderer to quit a question that already expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const withdraw = vi.fn();
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      answerTimeoutMs: 50,
      withdraw,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready", runningCount: 1 });

    vi.setSystemTime(1_051);
    expect(guard.allowPending()).toBe(false);
    expect(withdraw).toHaveBeenCalledWith("q1");
    await expect(decision).resolves.toBe(false);
  });

  it("cancels a pending decision when the renderer is replaced and can prompt again", async () => {
    const requestIds = ["q1", "q2"];
    const guard = makeRunningChatsQuitGuard(() => requestIds.shift() ?? "unexpected");
    const first = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready", runningCount: 1 });

    guard.cancelPendingUnlessPreparing();

    await expect(first).resolves.toBe(false);
    const send = vi.fn();
    const second = guard.askRenderer({ send, isRendererAvailable: () => true });
    expect(send).toHaveBeenCalledWith({ requestId: "q2", presentation: "in-app" });
    guard.receiveResponse({ requestId: "q2", phase: "decision", allow: true });
    await expect(second).resolves.toBe(true);
  });

  it("shows the native sheet after the renderer reports running chats", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const presentNativeConfirmation = vi.fn(async () => false);
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      presentation: "native",
      presentNativeConfirmation,
    });

    guard.receiveResponse({
      requestId: "q1",
      phase: "ready",
      runningCount: 1,
      chats: [{ id: "a", title: "Fix the tray" }],
    });

    await expect(decision).resolves.toBe(false);
    expect(presentNativeConfirmation).toHaveBeenCalledWith([{ id: "a", title: "Fix the tray" }]);
    expect(guard.hasAllowedQuit()).toBe(false);
  });

  it("fails open if the native sheet presenter throws", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      presentation: "native",
      presentNativeConfirmation: () => {
        throw new Error("sheet failed");
      },
    });

    guard.receiveResponse({
      requestId: "q1",
      phase: "ready",
      runningCount: 1,
      chats: [{ id: "a", title: "Fix the tray" }],
    });

    await expect(decision).resolves.toBe(true);
  });
});
