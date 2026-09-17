import { describe, expect, it } from "vitest";

import {
  formatWorkerWatchLine,
  isFailedWorkerSessionStatus,
  isManagedWorkerThread,
} from "./workerHealth.ts";

describe("worker health", () => {
  it("treats error, interrupt, and stop as dead workers", () => {
    expect(isFailedWorkerSessionStatus("error")).toBe(true);
    expect(isFailedWorkerSessionStatus("interrupted")).toBe(true);
    expect(isFailedWorkerSessionStatus("stopped")).toBe(true);
    expect(isFailedWorkerSessionStatus("running")).toBe(false);
    expect(isFailedWorkerSessionStatus("ready")).toBe(false);
  });

  it("recognizes indexed workers and hides the coordinator", () => {
    expect(
      isManagedWorkerThread({
        threadId: "worker-1",
        coordinatorThreadId: "coord-1",
        index: [
          { threadId: "coord-1", excluded: false, archived: false },
          { threadId: "worker-1", excluded: false, archived: false },
        ],
      }),
    ).toBe(true);
    expect(
      isManagedWorkerThread({
        threadId: "coord-1",
        coordinatorThreadId: "coord-1",
        index: [{ threadId: "coord-1", excluded: false, archived: false }],
      }),
    ).toBe(false);
  });

  it("formats a quota failure for the coordinator packet", () => {
    expect(
      formatWorkerWatchLine({
        title: "Sample Focus honesty",
        status: "error",
        lastError: "subscription quota limit",
      }),
    ).toBe("- Sample Focus honesty: error — subscription quota limit");
  });
});
