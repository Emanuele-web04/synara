import { ThreadId, TurnId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeApi = vi.hoisted(() => ({
  generateComposerPrediction: vi.fn(),
}));

vi.mock("react", async () => (await import("../test/reactHookHarness")).reactHookHarnessMock);
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    server: { generateComposerPrediction: nativeApi.generateComposerPrediction },
  }),
}));

import { composerPredictionStore, type ComposerPredictionTarget } from "~/lib/composerPrediction";
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
    composerPredictionStore.setState({ entries: new Map() });
    nativeApi.generateComposerPrediction.mockReset();
  });

  it("requests once per turn and shows the suggestion in an empty composer", async () => {
    nativeApi.generateComposerPrediction.mockResolvedValue({ suggestion: "Rerun that test" });
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

  it("discards for good a result the user typed over during the request", async () => {
    const response = deferred<{ suggestion: string | null }>();
    nativeApi.generateComposerPrediction.mockReturnValue(response.promise);
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    const signal = nativeApi.generateComposerPrediction.mock.calls[0]![1].signal as AbortSignal;

    hook.render({ prompt: "N", canShow: false });
    expect(signal.aborted).toBe(true);
    response.resolve({ suggestion: "Late suggestion" });
    await Promise.resolve();
    const cleared = hook.render({ prompt: "", canShow: true });

    expect(cleared.suggestion).toBeNull();
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("never brings back a suggestion after the user typed over it", async () => {
    nativeApi.generateComposerPrediction.mockResolvedValue({ suggestion: "Ship it" });
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    await vi.waitFor(() =>
      expect(composerPredictionStore.getState().entries.get("key-turn-1")?.status).toBe("ready"),
    );
    expect(hook.render().suggestion).toBe("Ship it");

    hook.render({ prompt: "Something else", canShow: false });
    const cleared = hook.render({ prompt: "", canShow: true });

    expect(cleared.suggestion).toBeNull();
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("hides an accepted suggestion for the rest of the turn", async () => {
    nativeApi.generateComposerPrediction.mockResolvedValue({ suggestion: "Ship it" });
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    await vi.waitFor(() =>
      expect(composerPredictionStore.getState().entries.get("key-turn-1")?.status).toBe("ready"),
    );

    hook.render().controller.consume("key-turn-1");

    expect(hook.render().suggestion).toBeNull();
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("settles silently when the request fails, without retrying", async () => {
    nativeApi.generateComposerPrediction.mockRejectedValue(new Error("offline"));
    const hook = mountHook({ target: target("turn-1"), canShow: true, prompt: "" });
    await vi.waitFor(() =>
      expect(composerPredictionStore.getState().entries.get("key-turn-1")?.status).toBe("done"),
    );

    expect(hook.render().suggestion).toBeNull();
    expect(nativeApi.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });
});
