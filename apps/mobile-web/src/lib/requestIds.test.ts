import { afterEach, describe, expect, it } from "vitest";

import {
  acquirePendingNewTask,
  clearPendingNewTask,
  pendingNewTask,
} from "./requestIds";

describe("pending new task identity", () => {
  afterEach(() => clearPendingNewTask("project-1"));

  it("survives route component remounts for the same logical task", () => {
    const first = acquirePendingNewTask("project-1", "same-payload", "First title");
    first.created = true;
    expect(acquirePendingNewTask("project-1", "same-payload", "Changed title")).toBe(first);
    expect(first.initialTitle).toBe("First title");
    expect(pendingNewTask("project-1")?.created).toBe(true);
  });

  it("rotates the thread identity when the task payload changes", () => {
    const first = acquirePendingNewTask("project-1", "payload-a", "A");
    const second = acquirePendingNewTask("project-1", "payload-b", "B");
    expect(second.threadId).not.toBe(first.threadId);
  });
});
