import { ThreadId, type Todo, TodoId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { applyTodoPatch } from "./todo";

const base: Todo = {
  id: TodoId.makeUnsafe("todo-patch"),
  title: "Summarize the notes",
  notes: "",
  priority: "none",
  projectId: null,
  dueDate: null,
  threadId: ThreadId.makeUnsafe("thread-a"),
  delegationBaseTurnId: TurnId.makeUnsafe("turn-a"),
  linkedAt: "2026-09-27T10:00:00.000Z",
  completedAt: null,
  createdAt: "2026-09-27T10:00:00.000Z",
  updatedAt: "2026-09-27T10:00:00.000Z",
};
const later = "2026-09-27T11:00:00.000Z";

describe("applyTodoPatch", () => {
  it("drops the base turn when the link moves without one, and keeps it otherwise", () => {
    expect(
      applyTodoPatch(base, { id: base.id, title: "Renamed" }, later).delegationBaseTurnId,
    ).toBe(base.delegationBaseTurnId);
    expect(applyTodoPatch(base, { id: base.id, threadId: null }, later).delegationBaseTurnId).toBe(
      null,
    );
    const relinked = applyTodoPatch(
      base,
      {
        id: base.id,
        threadId: ThreadId.makeUnsafe("thread-b"),
        delegationBaseTurnId: TurnId.makeUnsafe("turn-b"),
      },
      later,
    );
    expect(relinked.delegationBaseTurnId).toBe("turn-b");
    expect(relinked.linkedAt).toBe(later);
    expect(applyTodoPatch(base, { id: base.id, notes: "x" }, later).linkedAt).toBe(base.linkedAt);
  });

  it("stamps completion once and clears it on reopen", () => {
    const done = applyTodoPatch(base, { id: base.id, completed: true }, later);
    expect(done.completedAt).toBe(later);
    expect(applyTodoPatch(done, { id: base.id, completed: true }, "x").completedAt).toBe(later);
    expect(applyTodoPatch(done, { id: base.id, completed: false }, later).completedAt).toBe(null);
  });
});
