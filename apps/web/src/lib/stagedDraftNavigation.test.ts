import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  DRAFT_NAVIGATION_COALESCE_WINDOW_MS,
  draftNavigationSlotKey,
  getInFlightDraftThreadIds,
  runDraftNavigationOnce,
  stageDraftNavigation,
} from "./stagedDraftNavigation";

describe("stagedDraftNavigation", () => {
  it("finalizes only after the destination is active", async () => {
    const calls: string[] = [];

    const committed = await stageDraftNavigation({
      stage: () => calls.push("stage"),
      navigate: async () => {
        calls.push("navigate");
      },
      isDestinationActive: () => {
        calls.push("check");
        return true;
      },
      finalize: () => calls.push("finalize"),
      rollback: () => calls.push("rollback"),
    });

    expect(committed).toBe(true);
    expect(calls).toEqual(["stage", "navigate", "check", "finalize"]);
  });

  it("rolls back a staged draft when a newer navigation wins", async () => {
    const finalize = vi.fn();
    const rollback = vi.fn();

    const committed = await stageDraftNavigation({
      stage: vi.fn(),
      navigate: async () => undefined,
      isDestinationActive: () => false,
      finalize,
      rollback,
    });

    expect(committed).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("rolls back and preserves navigation failures", async () => {
    const rollback = vi.fn();
    const error = new Error("navigation failed");

    await expect(
      stageDraftNavigation({
        stage: vi.fn(),
        navigate: async () => {
          throw error;
        },
        isDestinationActive: () => false,
        finalize: vi.fn(),
        rollback,
      }),
    ).rejects.toBe(error);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent creation attempts for the same project slot", async () => {
    let finishFirst!: (value: string) => void;
    const firstRun = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const secondRun = vi.fn(async () => "second");
    const slotKey = draftNavigationSlotKey("project-studio", "chat");

    const first = runDraftNavigationOnce(slotKey, firstRun);
    const second = runDraftNavigationOnce(slotKey, secondRun);
    await Promise.resolve();
    finishFirst("first");

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("first");
    expect(firstRun).toHaveBeenCalledOnce();
    expect(secondRun).not.toHaveBeenCalled();

    await expect(runDraftNavigationOnce(slotKey, secondRun)).resolves.toBe("second");
    expect(secondRun).toHaveBeenCalledOnce();
  });

  it("tracks the draft thread id from stage through finalize", async () => {
    const threadId = ThreadId.makeUnsafe("thread-track-finalize");
    const finalize = vi.fn();
    let resolveNavigate!: () => void;
    const navigatePromise = new Promise<void>((resolve) => {
      resolveNavigate = resolve;
    });

    const stagePromise = stageDraftNavigation({
      draftThreadId: threadId,
      stage: () => undefined,
      navigate: () => navigatePromise,
      isDestinationActive: () => true,
      finalize,
      rollback: () => undefined,
    });

    expect(getInFlightDraftThreadIds().has(threadId)).toBe(true);
    resolveNavigate();
    await stagePromise;
    expect(finalize).toHaveBeenCalledOnce();
    expect(getInFlightDraftThreadIds().has(threadId)).toBe(false);
  });

  it("removes the draft thread id on rollback", async () => {
    const threadId = ThreadId.makeUnsafe("thread-track-rollback");
    const rollback = vi.fn();

    const stagePromise = stageDraftNavigation({
      draftThreadId: threadId,
      stage: () => undefined,
      navigate: async () => undefined,
      isDestinationActive: () => false,
      finalize: () => undefined,
      rollback,
    });

    expect(getInFlightDraftThreadIds().has(threadId)).toBe(true);
    await stagePromise;
    expect(rollback).toHaveBeenCalledOnce();
    expect(getInFlightDraftThreadIds().has(threadId)).toBe(false);
  });
  it.each(["before staging", "during navigation"] as const)(
    "releases a cancelled draft %s without finalizing it",
    async (cancelAt) => {
      const draftThreadId = ThreadId.makeUnsafe(`cancelled-${cancelAt}`);
      const controller = new AbortController();
      const stage = vi.fn();
      const finalize = vi.fn();
      const rollback = vi.fn();
      if (cancelAt === "before staging") controller.abort();

      const committed = await stageDraftNavigation({
        draftThreadId,
        signal: controller.signal,
        stage,
        navigate: async () => {
          expect(getInFlightDraftThreadIds().has(draftThreadId)).toBe(true);
          controller.abort();
        },
        isDestinationActive: () => true,
        finalize,
        rollback,
      });

      expect(committed).toBe(false);
      expect(stage).toHaveBeenCalledTimes(cancelAt === "before staging" ? 0 : 1);
      expect(finalize).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledOnce();
      expect(getInFlightDraftThreadIds().has(draftThreadId)).toBe(false);
    },
  );

  it("releases draft tracking even when rollback itself throws", async () => {
    const draftThreadId = ThreadId.makeUnsafe("rollback-throws");
    const rollback = vi.fn(() => {
      throw new Error("rollback failed");
    });
    await expect(
      stageDraftNavigation({
        draftThreadId,
        stage: () => undefined,
        navigate: async () => undefined,
        isDestinationActive: () => false,
        finalize: () => undefined,
        rollback,
      }),
    ).rejects.toThrow("rollback failed");
    expect(rollback).toHaveBeenCalledOnce();
    expect(getInFlightDraftThreadIds().has(draftThreadId)).toBe(false);
  });

  it("does not let a navigation that never settles block later attempts", async () => {
    vi.useFakeTimers();
    try {
      const stuckRun = vi.fn(() => new Promise<string>(() => undefined));
      const retryRun = vi.fn(async () => "retry");
      const slotKey = draftNavigationSlotKey("project-stuck", "chat");

      const stuck = runDraftNavigationOnce(slotKey, stuckRun);
      // A double click right away still joins the pending attempt.
      expect(runDraftNavigationOnce(slotKey, retryRun)).toBe(stuck);
      await Promise.resolve();
      expect(stuckRun).toHaveBeenCalledOnce();
      expect(retryRun).not.toHaveBeenCalled();

      // Once the attempt is clearly lost, "New thread" must work again without a reload.
      vi.advanceTimersByTime(DRAFT_NAVIGATION_COALESCE_WINDOW_MS);
      await expect(runDraftNavigationOnce(slotKey, retryRun)).resolves.toBe("retry");
      expect(retryRun).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps the newer draft when expired preparation finishes after the retry", async () => {
    vi.useFakeTimers();
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let activeDraft = "home";
    const finalized: string[] = [];
    const staged: string[] = [];
    const slotKey = draftNavigationSlotKey("project-slow-group", "chat");
    const createDraft = (name: string, beforeStage: Promise<void>) =>
      runDraftNavigationOnce(slotKey, async (signal?: AbortSignal) => {
        await beforeStage;
        return stageDraftNavigation({
          signal,
          stage: () => {
            staged.push(name);
          },
          navigate: async () => {
            activeDraft = name;
          },
          isDestinationActive: () => activeDraft === name,
          finalize: () => {
            finalized.push(name);
          },
          rollback: () => undefined,
        });
      });
    try {
      const older = createDraft("older", preparation);
      await Promise.resolve();
      vi.advanceTimersByTime(DRAFT_NAVIGATION_COALESCE_WINDOW_MS);
      await expect(createDraft("newer", Promise.resolve())).resolves.toBe(true);
      expect(activeDraft).toBe("newer");
      releasePreparation();
      await older;
      expect(activeDraft).toBe("newer");
      expect(staged).toEqual(["newer"]);
      expect(finalized).toEqual(["newer"]);
    } finally {
      releasePreparation();
      vi.useRealTimers();
    }
  });
});
