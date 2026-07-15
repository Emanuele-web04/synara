import { describe, expect, it } from "vitest";

import {
  makeRuntimeTaskListItem,
  nonEmptyRuntimeTaskListPayload,
  normalizeRuntimeTaskStatus,
} from "./runtimeTaskList.ts";

describe("runtimeTaskList", () => {
  it("normalizes provider task statuses", () => {
    expect(normalizeRuntimeTaskStatus("pending")).toBe("pending");
    expect(normalizeRuntimeTaskStatus("in_progress")).toBe("inProgress");
    expect(normalizeRuntimeTaskStatus("inProgress")).toBe("inProgress");
    expect(normalizeRuntimeTaskStatus("completed")).toBe("completed");
    expect(normalizeRuntimeTaskStatus("unknown")).toBe("pending");
  });

  it("builds trimmed task items and rejects empty labels", () => {
    expect(makeRuntimeTaskListItem("  Inspect files  ", "in_progress")).toEqual({
      task: "Inspect files",
      status: "inProgress",
    });
    expect(makeRuntimeTaskListItem("   ", "pending")).toBeNull();
    expect(makeRuntimeTaskListItem(undefined, "pending")).toBeNull();
  });

  it("builds only non-empty legacy task snapshots", () => {
    expect(nonEmptyRuntimeTaskListPayload([])).toBeNull();
    expect(nonEmptyRuntimeTaskListPayload([{ task: "Inspect files", status: "pending" }])).toEqual({
      tasks: [{ task: "Inspect files", status: "pending" }],
    });
  });
});
