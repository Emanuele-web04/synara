import { describe, expect, it } from "vitest";

import {
  allowedDigestSources,
  mergePinnedFocusItems,
  validateDigestFocusItems,
  wakeReceiptRequestId,
} from "./digest";

describe("project digest helpers", () => {
  it("drops focus items without a known source", () => {
    const allowed = allowedDigestSources({
      activityIds: ["act-1"],
      taskIds: ["task-1"],
      threadIds: ["thread-1"],
      documentPaths: ["decisions.md"],
    });
    const items = validateDigestFocusItems(
      [
        { title: "Known task", kind: "task", source: "task-1" },
        { title: "Invented", kind: "blocker", source: "missing" },
      ],
      allowed,
    );
    expect(items.map((item) => item.title)).toEqual(["Known task"]);
  });

  it("keeps pinned items ahead of generated ones", () => {
    const pinned = [
      {
        id: "pin-1",
        title: "Pinned",
        kind: "task" as const,
        pinned: true,
      },
    ];
    const generated = [
      { id: "pin-1", title: "Duplicate", kind: "task" as const, pinned: false },
      { id: "gen-2", title: "New", kind: "blocker" as const, pinned: false },
    ];
    expect(mergePinnedFocusItems(generated, pinned).map((item) => item.id)).toEqual([
      "pin-1",
      "gen-2",
    ]);
  });

  it("uses a stable wake receipt id for an event range", () => {
    expect(
      wakeReceiptRequestId({
        projectId: "project-1",
        fromInboxId: "a",
        toInboxId: "b",
      }),
    ).toBe("wake:project-1:a:b");
  });
});
