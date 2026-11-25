import { ThreadId, TurnId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeApi = vi.hoisted(() => ({
  generateComposerPrediction: vi.fn(),
}));

vi.mock("react", async () => (await import("../test/reactHookHarness")).reactHookHarnessMock);
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    server: { generateComposerPrediction: nativeApi.generateComposerPrediction },
  }),
}));

import {
  COMPOSER_PREDICTION_RETRY_DELAYS_MS,
  composerPredictionStore,
  type ComposerPredictionTarget,
} from "~/lib/composerPrediction";
import { reactHookHarness } from "../test/reactHookHarness";
import { useComposerPrediction } from "./useComposerPrediction";

const THREAD = ThreadId.makeUnsafe("thread-1");
const target = (turn: string, key = `key-${turn}`): ComposerPredictionTarget => ({
  key,
  threadId: THREAD,
  turnId: TurnId.makeUnsafe(turn),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface HookInput {
  target: ComposerPredictionTarget | null;
  canShow: boolean;
  prompt: string;
}

/** Lets a resolved request land in the store. */
async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

const entryOf = (key = "key-turn-1") => composerPredictionStore.getState().entries.get(key);

function mountHook(initial: HookInput) {
  let input = initial;
  const render = (next: Partial<HookInput> = {}) => {
    input = { ...input, ...next };
    reactHookHarness.beginRender();
    return useComposerPrediction(input);
  };
  return { render, first: render() };
}

describe("useComposerPrediction", () => {
  beforeEach(() => {
    reactHookHarness.reset();
    composerPredictionStore.setState({ entries: new Map(), settledKeys: new Set() });
    nativeApi.generateComposerPrediction.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests once per turn and shows the suggestion in an empty composer", async () => {
    nativeApi.generateComposerPrediction.mockResolvedValue({
      suggestion: "Rerun that test",
      outcome: "suggested",
    });
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });

    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledWith(
      { threadId: THREAD, expectedTurnId: "turn-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(hook.first.suggestion).toBeNull();
    await vi.waitFor(() =>
      expect(composerPredictionStore.getState().entries.get("key-turn-1")?.status).toBe("ready"),
    );

    const shown = hook.render();
    expect(shown.suggestion).toBe("Rerun that test");
    expect(shown.controller.readVisible()).toEqual({
      key: "key-turn-1",
      suggestion: "Rerun that test",
    });
    hook.render({ canShow: false });
    hook.render({ canShow: true });
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("does not request while the ghost text could not show", () => {
    mountHook({ target: target("turn-1"), canShow: false, prompt: "" });
    expect(nativeApi.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it("aborts and discards the result when the turn changes during the request", async () => {
    const response = deferred<{ suggestion: string | null }>();
    nativeApi.generateComposerPrediction.mockReturnValue(response.promise);
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    const signal = nativeApi.generateComposerPrediction.mock.calls[0]![1].signal as AbortSignal;

    nativeApi.generateComposerPrediction.mockReturnValue(new Promise(() => {}));
    hook.render({ target: target("turn-2") });
    expect(signal.aborted).toBe(true);
    response.resolve({ suggestion: "Stale" });
    await Promise.resolve();

    expect(composerPredictionStore.getState().entries.has("key-turn-1")).toBe(false);
    expect(hook.render().suggestion).toBeNull();
  });

  it("aborts when predictions are turned off", () => {
    nativeApi.generateComposerPrediction.mockReturnValue(new Promise(() => {}));
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    const signal = nativeApi.generateComposerPrediction.mock.calls[0]![1].signal as AbortSignal;

    hook.render({ target: null });

    expect(signal.aborted).toBe(true);
    expect(composerPredictionStore.getState().entries.has("key-turn-1")).toBe(false);
  });

  it("keeps a request running while the user types and shows its result once emptied", async () => {
    const response = deferred<{ suggestion: string | null; outcome?: string }>();
    nativeApi.generateComposerPrediction.mockReturnValue(response.promise);
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    const signal = nativeApi.generateComposerPrediction.mock.calls[0]![1].signal as AbortSignal;

    hook.render({ prompt: "N", canShow: false });
    expect(signal.aborted).toBe(false);
    response.resolve({ suggestion: "Late suggestion", outcome: "suggested" });
    await flush();
    const typing = hook.render();
    expect(typing.suggestion).toBeNull();
    expect(typing.ghost).toBeNull();

    const cleared = hook.render({ prompt: "", canShow: true });
    expect(cleared.suggestion).toBe("Late suggestion");
    expect(cleared.ghost).toBe("Late suggestion");
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("hides a shown suggestion while the user types and brings it back when emptied", async () => {
    nativeApi.generateComposerPrediction.mockResolvedValue({
      suggestion: "Ship it",
      outcome: "suggested",
    });
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    await flush();
    expect(hook.render().suggestion).toBe("Ship it");

    const typing = hook.render({ prompt: "Something else", canShow: false });
    expect(typing.suggestion).toBeNull();
    expect(typing.ghost).toBeNull();
    expect(typing.controller.readVisible()).toBeNull();
    expect(composerPredictionStore.getState().settledKeys.has("key-turn-1")).toBe(false);

    const cleared = hook.render({ prompt: "", canShow: true });
    expect(cleared.suggestion).toBe("Ship it");
    expect(cleared.controller.readVisible()).toEqual({ key: "key-turn-1", suggestion: "Ship it" });
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("hides an accepted suggestion for the rest of the turn", async () => {
    nativeApi.generateComposerPrediction.mockResolvedValue({
      suggestion: "Ship it",
      outcome: "suggested",
    });
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    await flush();

    const shown = hook.render();
    expect(shown.ghost).toBe("Ship it");
    shown.controller.accept({ key: "key-turn-1", suggestion: "Ship it" });

    // The draft is on its way into the editor: the text stays the ghost so the composer
    // never empties in between, but there is nothing left to accept.
    const accepting = hook.render({ prompt: "Ship it", canShow: false });
    expect(accepting.suggestion).toBeNull();
    expect(accepting.ghost).toBe("Ship it");
    expect(accepting.controller.readVisible()).toBeNull();
    expect(entryOf()?.status).toBe("done");
    expect(composerPredictionStore.getState().settledKeys.has("key-turn-1")).toBe(true);

    // Any edit, including clearing the draft, ends it for this turn.
    expect(hook.render({ prompt: "Ship it now", canShow: false }).ghost).toBeNull();
    const cleared = hook.render({ prompt: "", canShow: true });
    expect(cleared.suggestion).toBeNull();
    expect(cleared.ghost).toBeNull();

    // Leaving the chat and coming back does not bring it back either.
    hook.render({ target: null });
    const back = hook.render({ target: target("turn-1") });
    expect(back.suggestion).toBeNull();
    expect(back.ghost).toBeNull();
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("settles the turn for good when the model has no suggestion", async () => {
    vi.useFakeTimers();
    nativeApi.generateComposerPrediction.mockResolvedValue({ suggestion: null, outcome: "none" });
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    await flush();
    hook.render();

    expect(entryOf()?.status).toBe("done");
    expect(composerPredictionStore.getState().settledKeys.has("key-turn-1")).toBe(true);
    vi.advanceTimersByTime(60_000);
    hook.render({ target: null });
    hook.render({ target: target("turn-1") });
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("retries an unavailable answer after 2, 5, and 15 seconds, then stops", async () => {
    vi.useFakeTimers();
    nativeApi.generateComposerPrediction.mockResolvedValue({
      suggestion: null,
      outcome: "unavailable",
    });
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });

    for (const [index, delayMs] of COMPOSER_PREDICTION_RETRY_DELAYS_MS.entries()) {
      await flush();
      expect(entryOf()).toEqual({ status: "unavailable", attempts: index + 1 });
      hook.render();
      vi.advanceTimersByTime(delayMs - 1);
      expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(index + 1);
      vi.advanceTimersByTime(1);
      expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(index + 2);
      hook.render();
    }

    await flush();
    hook.render();
    vi.advanceTimersByTime(10 * 60_000);
    hook.render();
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(4);
    expect(entryOf()).toEqual({ status: "unavailable", attempts: 4 });
    expect(composerPredictionStore.getState().settledKeys.has("key-turn-1")).toBe(false);
  });

  it("asks afresh once the user leaves the turn and comes back after the retries ran out", async () => {
    vi.useFakeTimers();
    nativeApi.generateComposerPrediction.mockResolvedValue({
      suggestion: null,
      outcome: "unavailable",
    });
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    for (const delayMs of COMPOSER_PREDICTION_RETRY_DELAYS_MS) {
      await flush();
      hook.render();
      vi.advanceTimersByTime(delayMs);
      hook.render();
    }
    await flush();
    hook.render();
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(4);

    nativeApi.generateComposerPrediction.mockResolvedValue({
      suggestion: "Rerun that test",
      outcome: "suggested",
    });
    hook.render({ target: null });
    expect(entryOf()).toBeUndefined();
    hook.render({ target: target("turn-1") });
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(5);
    await flush();
    expect(hook.render().suggestion).toBe("Rerun that test");
  });

  it("treats a bare null from an older server as unavailable and retries it", async () => {
    vi.useFakeTimers();
    nativeApi.generateComposerPrediction
      .mockResolvedValueOnce({ suggestion: null })
      .mockResolvedValueOnce({ suggestion: "Rerun that test" });
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    await flush();
    hook.render();
    expect(composerPredictionStore.getState().settledKeys.has("key-turn-1")).toBe(false);

    vi.advanceTimersByTime(COMPOSER_PREDICTION_RETRY_DELAYS_MS[0]!);
    await flush();
    expect(hook.render().suggestion).toBe("Rerun that test");
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });

  it("retries a failed request silently, on the same schedule", async () => {
    vi.useFakeTimers();
    nativeApi.generateComposerPrediction
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce({ suggestion: "Rerun that test", outcome: "suggested" });
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    await flush();
    expect(entryOf()).toEqual({ status: "unavailable", attempts: 1, limitRetries: true });
    expect(hook.render().suggestion).toBeNull();

    vi.advanceTimersByTime(COMPOSER_PREDICTION_RETRY_DELAYS_MS[0]!);
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(2);
    await flush();
    expect(hook.render().suggestion).toBe("Rerun that test");
  });

  it.each([
    ["a failed generation", { suggestion: null, outcome: "generation-unavailable" }],
    ["an older server", { suggestion: null }],
    ["a dropped connection", undefined],
  ])("limits retries when provider work may have run after %s", async (_case, result) => {
    vi.useFakeTimers();
    if (result) nativeApi.generateComposerPrediction.mockResolvedValue(result);
    else nativeApi.generateComposerPrediction.mockRejectedValue(new Error("socket closed"));
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    await flush();
    hook.render();
    vi.advanceTimersByTime(COMPOSER_PREDICTION_RETRY_DELAYS_MS[0]!);
    await flush();
    hook.render();
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60_000);
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(2);
    expect(composerPredictionStore.getState().settledKeys.has("key-turn-1")).toBe(false);
    hook.render({ target: null });
    hook.render({ target: target("turn-1") });
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(3);
  });

  it("holds a retry while the ghost could not show and waits the full delay after", async () => {
    vi.useFakeTimers();
    nativeApi.generateComposerPrediction.mockResolvedValue({
      suggestion: null,
      outcome: "unavailable",
    });
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    await flush();
    hook.render();
    vi.advanceTimersByTime(1_000);

    hook.render({ prompt: "typing", canShow: false });
    vi.advanceTimersByTime(30_000);
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(1);

    hook.render({ prompt: "", canShow: true });
    vi.advanceTimersByTime(COMPOSER_PREDICTION_RETRY_DELAYS_MS[0]! - 1);
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });

  it("drops a pending retry when the turn changes or the chat unmounts", async () => {
    vi.useFakeTimers();
    nativeApi.generateComposerPrediction.mockResolvedValue({
      suggestion: null,
      outcome: "unavailable",
    });
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    await flush();
    hook.render();

    nativeApi.generateComposerPrediction.mockReturnValue(new Promise(() => {}));
    hook.render({ target: target("turn-2") });
    expect(entryOf("key-turn-1")).toBeUndefined();
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(2);
    reactHookHarness.unmount();
    vi.advanceTimersByTime(60_000);
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });

  it("never asks again for a turn that was settled before this page loaded", () => {
    composerPredictionStore.setState({ settledKeys: new Set(["key-turn-1"]) });
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });

    expect(hook.first.suggestion).toBeNull();
    expect(nativeApi.generateComposerPrediction).not.toHaveBeenCalled();
  });
});
