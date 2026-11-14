import { describe, expect, it } from "vitest";

import {
  type BackgroundTaskActivity,
  canSessionFinishBackgroundTasks,
  foldOutstandingBackgroundTaskIds,
  isBackgroundTaskActivity,
} from "./backgroundTasks";

const movedToBackground = (...taskIds: string[]): BackgroundTaskActivity => ({
  kind: "runtime.warning",
  payload: {
    nativeEventType: "background_tasks_changed",
    data: { tasks: taskIds.map((task_id) => ({ task_id })) },
  },
});

const taskUpdated = (taskId: string, patch: Record<string, unknown>): BackgroundTaskActivity => ({
  kind: "task.updated",
  payload: { taskId, ...patch },
});

const taskCompleted = (taskId: string): BackgroundTaskActivity => ({
  kind: "task.completed",
  payload: { taskId },
});

describe("foldOutstandingBackgroundTaskIds", () => {
  it("adds tasks from a Moved to background notice and removes them when they complete", () => {
    expect(foldOutstandingBackgroundTaskIds([movedToBackground("a", "b")])).toEqual(["a", "b"]);
    expect(
      foldOutstandingBackgroundTaskIds([movedToBackground("a", "b"), taskCompleted("a")]),
    ).toEqual(["b"]);
  });

  it("applies task.updated patches in the given order", () => {
    expect(foldOutstandingBackgroundTaskIds([taskUpdated("a", { isBackgrounded: true })])).toEqual([
      "a",
    ]);
    for (const status of ["completed", "failed", "killed", "paused"]) {
      expect(
        foldOutstandingBackgroundTaskIds([
          taskUpdated("a", { isBackgrounded: true }),
          taskUpdated("a", { status }),
        ]),
      ).toEqual([]);
    }
    expect(
      foldOutstandingBackgroundTaskIds([
        movedToBackground("a"),
        taskUpdated("a", { isBackgrounded: false }),
      ]),
    ).toEqual([]);
    // Order matters: a later backgrounding re-adds a task that had ended.
    expect(
      foldOutstandingBackgroundTaskIds([
        taskUpdated("a", { status: "paused" }),
        taskUpdated("a", { isBackgrounded: true }),
      ]),
    ).toEqual(["a"]);
  });

  it("ignores running status patches, other warnings, and malformed payloads", () => {
    expect(
      foldOutstandingBackgroundTaskIds([
        taskUpdated("a", { status: "running" }),
        { kind: "runtime.warning", payload: { nativeEventType: "other", data: { tasks: [] } } },
        { kind: "runtime.warning", payload: { nativeEventType: "background_tasks_changed" } },
        {
          kind: "runtime.warning",
          payload: { nativeEventType: "background_tasks_changed", data: { tasks: [{}, null, 1] } },
        },
        { kind: "task.completed", payload: null },
        { kind: "task.progress", payload: { taskId: "b", isBackgrounded: true } },
      ]),
    ).toEqual([]);
  });
});

describe("isBackgroundTaskActivity", () => {
  it("matches only activities that can change the outstanding set", () => {
    expect(isBackgroundTaskActivity(movedToBackground("a"))).toBe(true);
    expect(isBackgroundTaskActivity(taskUpdated("a", {}))).toBe(true);
    expect(isBackgroundTaskActivity(taskCompleted("a"))).toBe(true);
    expect(isBackgroundTaskActivity({ kind: "task.progress", payload: { taskId: "a" } })).toBe(
      false,
    );
    expect(isBackgroundTaskActivity({ kind: "runtime.warning", payload: {} })).toBe(false);
  });
});

describe("canSessionFinishBackgroundTasks", () => {
  it("treats missing, stopped, and errored sessions as unable to finish work", () => {
    expect(canSessionFinishBackgroundTasks(undefined)).toBe(false);
    expect(canSessionFinishBackgroundTasks(null)).toBe(false);
    expect(canSessionFinishBackgroundTasks("stopped")).toBe(false);
    expect(canSessionFinishBackgroundTasks("error")).toBe(false);
    expect(canSessionFinishBackgroundTasks("ready")).toBe(true);
    expect(canSessionFinishBackgroundTasks("running")).toBe(true);
  });
});
