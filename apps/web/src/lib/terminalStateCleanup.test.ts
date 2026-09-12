import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  collectActiveTerminalThreadIds,
  registerTerminalRuntimeCleanup,
  removeOrphanedTerminalRuntimes,
} from "./terminalStateCleanup";

const threadId = (id: string): ThreadId => ThreadId.makeUnsafe(id);

it("cleans up loaded runtimes synchronously without a stale registration replacing the current one", () => {
  const active = new Set(["active", "dock-terminal:active", "draft"]);
  expect(() => removeOrphanedTerminalRuntimes(active)).not.toThrow();
  const oldCleanup = vi.fn();
  const newCleanup = vi.fn();
  const unregisterOld = registerTerminalRuntimeCleanup(oldCleanup);
  const unregisterNew = registerTerminalRuntimeCleanup(newCleanup);
  unregisterOld();
  removeOrphanedTerminalRuntimes(active);
  expect(oldCleanup).not.toHaveBeenCalled();
  expect(newCleanup).toHaveBeenCalledWith(active);
  unregisterNew();
  removeOrphanedTerminalRuntimes(new Set());
  expect(newCleanup).toHaveBeenCalledOnce();
});

describe("collectActiveTerminalThreadIds", () => {
  it("retains non-deleted server threads", () => {
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [
        { id: threadId("server-1"), deletedAt: null, archivedAt: null },
        { id: threadId("server-2"), deletedAt: null, archivedAt: null },
      ],
      draftThreadIds: [],
    });

    expect(activeThreadIds).toEqual(new Set([threadId("server-1"), threadId("server-2")]));
  });

  it("ignores deleted server threads and keeps local draft threads", () => {
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [
        { id: threadId("server-active"), deletedAt: null, archivedAt: null },
        {
          id: threadId("server-deleted"),
          deletedAt: "2026-03-05T08:00:00.000Z",
          archivedAt: null,
        },
      ],
      draftThreadIds: [threadId("local-draft")],
    });

    expect(activeThreadIds).toEqual(new Set([threadId("server-active"), threadId("local-draft")]));
  });

  it("retains explicitly provided terminal scopes", () => {
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [],
      draftThreadIds: [],
      retainedThreadIds: [threadId("retained:alpha"), threadId("retained:beta")],
    });

    expect(activeThreadIds).toEqual(
      new Set([threadId("retained:alpha"), threadId("retained:beta")]),
    );
  });

  it("ignores archived server threads", () => {
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [
        { id: threadId("server-active"), deletedAt: null, archivedAt: null },
        {
          id: threadId("server-archived"),
          deletedAt: null,
          archivedAt: "2026-03-05T09:00:00.000Z",
        },
      ],
      draftThreadIds: [],
    });

    expect(activeThreadIds).toEqual(new Set([threadId("server-active")]));
  });

  it("does not retain draft-linked state for archived server threads", () => {
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [
        {
          id: threadId("server-archived"),
          deletedAt: null,
          archivedAt: "2026-03-05T09:00:00.000Z",
        },
      ],
      draftThreadIds: [threadId("server-archived"), threadId("local-draft")],
    });

    expect(activeThreadIds).toEqual(new Set([threadId("local-draft")]));
  });
});
