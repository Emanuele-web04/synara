import { describe, expect, it } from "vitest";

import {
  classifyWorkerSettlement,
  formatWorkerBatchRollup,
  formatWorkerSettlementReport,
  formatWorkerWatchLine,
  isFailedWorkerSessionStatus,
  isManagedWorkerThread,
  isWorkerAlertEvent,
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

  it("recognizes only task-assigned workers and hides the coordinator", () => {
    expect(
      isManagedWorkerThread({
        threadId: "worker-1",
        coordinatorThreadId: "coord-1",
        assignedThreadIds: new Set(["coord-1", "worker-1"]),
      }),
    ).toBe(true);
    expect(
      isManagedWorkerThread({
        threadId: "user-chat",
        coordinatorThreadId: "coord-1",
        assignedThreadIds: new Set(["worker-1"]),
      }),
    ).toBe(false);
    expect(
      isManagedWorkerThread({
        threadId: "coord-1",
        coordinatorThreadId: "coord-1",
        assignedThreadIds: new Set(["coord-1"]),
      }),
    ).toBe(false);
  });

  it("treats errors and needs-user settles as wake-eligible alerts", () => {
    expect(isWorkerAlertEvent("worker.error")).toBe(true);
    expect(isWorkerAlertEvent("worker.interrupted")).toBe(true);
    expect(isWorkerAlertEvent("worker.missing")).toBe(true);
    expect(isWorkerAlertEvent("worker.stopped")).toBe(true);
    expect(isWorkerAlertEvent("worker.disconnected")).toBe(true);
    expect(isWorkerAlertEvent("worker.never-started")).toBe(true);
    expect(isWorkerAlertEvent("worker.tool-overtime")).toBe(true);
    // Request-side waiting signals (provider raised them) alert; the
    // response-requested event types fire when the USER answers — not alerts.
    expect(isWorkerAlertEvent("approval.requested")).toBe(true);
    expect(isWorkerAlertEvent("user-input.requested")).toBe(true);
    expect(isWorkerAlertEvent("thread.approval-response-requested")).toBe(false);
    expect(isWorkerAlertEvent("thread.user-input-response-requested")).toBe(false);
    expect(isWorkerAlertEvent("thread.turn-diff-completed")).toBe(false);
    expect(isWorkerAlertEvent("thread.session-set")).toBe(false);
  });

  it("formats roll-up entries with results, PR links, and no-result notes", () => {
    expect(
      formatWorkerBatchRollup({
        threads: [
          {
            title: "Alpha",
            outcome: "completed",
            result: "Shipped the migration — 12 files",
            pr: "https://github.com/diliprt/synara/pull/42",
          },
          { title: "Beta", outcome: "completed" },
          { title: "Gamma", outcome: "waiting-approval" },
        ],
      }),
    ).toBe(
      "All 3 threads settled: Alpha: Shipped the migration — 12 files — https://github.com/diliprt/synara/pull/42, Beta \u2713 — no result filed, Gamma \u26a0 needs approval",
    );
    expect(
      formatWorkerBatchRollup({
        threads: [
          { title: "Alpha", outcome: "completed" },
          { title: "Beta", outcome: "stopped" },
        ],
      }),
    ).toBe("All 2 threads finished: Alpha \u2713 — no result filed, Beta \u2713");
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
    expect(workerInboxReportPath("thread-worker")).toBe("inbox/thread-worker/report.md");
  });

  it("materializes reports from settle and health events, not approval prompts", () => {
    expect(shouldMaterializeWorkerSettlementReport("thread.turn-diff-completed")).toBe(true);
    expect(shouldMaterializeWorkerSettlementReport("thread.session-stop-requested")).toBe(true);
    expect(shouldMaterializeWorkerSettlementReport("worker.error")).toBe(true);
    expect(shouldMaterializeWorkerSettlementReport("thread.approval-response-requested")).toBe(
      false,
    );
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
    });
    expect(report).toContain("Outcome: completed");
    expect(report).toContain("Top-level folders: apps, packages, docs.");
    expect(report).toContain("thread-worker");
  });
});
