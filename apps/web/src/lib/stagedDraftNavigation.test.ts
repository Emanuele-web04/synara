import { describe, expect, it, vi } from "vitest";

import {
  draftNavigationSlotKey,
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
});
