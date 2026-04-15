import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { collectActiveTerminalThreadIds } from "./terminalStateCleanup";

const threadId = (id: string): ThreadId => ThreadId.makeUnsafe(id);

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

  it("retains synthetic workspace terminal scopes", () => {
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [],
      draftThreadIds: [],
      retainedThreadIds: [threadId("workspace:alpha"), threadId("workspace:beta")],
    });

    expect(activeThreadIds).toEqual(
      new Set([threadId("workspace:alpha"), threadId("workspace:beta")]),
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
