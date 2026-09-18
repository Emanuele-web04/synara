import { describe, expect, it } from "vitest";

import {
  classifyWorkerSettlement,
  formatWorkerSettlementReport,
  formatWorkerWatchLine,
  isFailedWorkerSessionStatus,
  isManagedWorkerThread,
  lastAssistantTextFromMessages,
  shouldMaterializeWorkerSettlementReport,
  workerInboxReportPath,
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

  it("writes a settlement report path under the worker inbox", () => {
    expect(workerInboxReportPath("thread-worker")).toBe(
      "inbox/thread-worker/report.md",
    );
  });

  it("materializes reports from settle and health events, not approval prompts", () => {
    expect(
      shouldMaterializeWorkerSettlementReport("thread.turn-diff-completed"),
    ).toBe(true);
    expect(
      shouldMaterializeWorkerSettlementReport("thread.session-stop-requested"),
    ).toBe(true);
    expect(shouldMaterializeWorkerSettlementReport("worker.error")).toBe(true);
    expect(
      shouldMaterializeWorkerSettlementReport(
        "thread.approval-response-requested",
      ),
    ).toBe(false);
  });

  it("classifies quota death as failed and a finished turn as completed", () => {
    expect(
      classifyWorkerSettlement({
        eventType: "worker.error",
        sessionStatus: "error",
      }),
    ).toBe("failed");
    expect(
      classifyWorkerSettlement({
        eventType: "thread.turn-diff-completed",
        sessionStatus: "ready",
      }),
    ).toBe("completed");
  });

  it("does not treat a finished worker as failed", () => {
    expect(
      classifyWorkerSettlement({
        eventType: "thread.turn-diff-completed",
        sessionStatus: "ready",
      }),
    ).toBe("completed");
    expect(
      classifyWorkerSettlement({
        eventType: "worker.stopped",
        sessionStatus: "stopped",
      }),
    ).not.toBe("failed");
  });

  it("does not treat a user stop or archive with no error as failed", () => {
    expect(
      classifyWorkerSettlement({
        eventType: "worker.stopped",
        sessionStatus: "stopped",
      }),
    ).toBe("completed");
    expect(
      classifyWorkerSettlement({
        eventType: "thread.session-stop-requested",
        sessionStatus: "stopped",
      }),
    ).toBe("completed");
  });

  it("maps a real error status to failed", () => {
    expect(
      classifyWorkerSettlement({
        eventType: "worker.error",
        sessionStatus: "error",
      }),
    ).toBe("failed");
    expect(
      classifyWorkerSettlement({
        eventType: "thread.turn-diff-completed",
        sessionStatus: "error",
      }),
    ).toBe("failed");
  });

  it("maps an interrupt to interrupted", () => {
    expect(
      classifyWorkerSettlement({
        eventType: "thread.turn-interrupt-requested",
        sessionStatus: "running",
      }),
    ).toBe("interrupted");
    expect(
      classifyWorkerSettlement({
        eventType: "worker.interrupted",
        sessionStatus: "interrupted",
      }),
    ).toBe("interrupted");
  });

  it("takes the latest assistant text for the durable report", () => {
    expect(
      lastAssistantTextFromMessages([
        { role: "user", text: "do the sample" },
        { role: "assistant", text: "first draft" },
        { role: "assistant", text: "done: README has 5 setup bullets" },
      ]),
    ).toBe("done: README has 5 setup bullets");
  });

  it("formats a durable worker report without needing the worker to call a tool", () => {
    const report = formatWorkerSettlementReport({
      title: "Sample: repo layout",
      threadId: "thread-worker",
      eventType: "thread.turn-diff-completed",
      status: "ready",
      lastError: null,
      lastAssistantText: "Top-level folders: apps, packages, docs.",
      createdAt: "2026-09-17T19:14:00.000Z",
    });
    expect(report).toContain("Outcome: completed");
    expect(report).toContain("Top-level folders: apps, packages, docs.");
    expect(report).toContain("thread-worker");
  });
});
