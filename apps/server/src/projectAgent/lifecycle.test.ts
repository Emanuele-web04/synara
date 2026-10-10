import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { canStartGoal, canWriteUserOwnedDocuments } from "./principal";
import { wakeReceiptRequestId } from "./digest";

describe("project coordinator lifecycle guards", () => {
  it("keeps ordinary provider callers off user-owned document writes", () => {
    const unmanaged = {
      kind: "unmanaged" as const,
      threadId: ThreadId.makeUnsafe("thread-ordinary"),
      projectId: ProjectId.makeUnsafe("project-a"),
    };
    expect(canStartGoal(unmanaged)).toBe(false);
    expect(canWriteUserOwnedDocuments(unmanaged)).toBe(false);
  });

  it("uses a stable event-range receipt so wake restart cannot silently replace the operation", () => {
    const first = wakeReceiptRequestId({
      projectId: "project-a",
      fromInboxId: "inbox-1",
      toInboxId: "inbox-4",
    });
    const retry = wakeReceiptRequestId({
      projectId: "project-a",
      fromInboxId: "inbox-1",
      toInboxId: "inbox-4",
    });
    expect(first).toBe(retry);
    expect(first).not.toBe(
      wakeReceiptRequestId({
        projectId: "project-a",
        fromInboxId: "inbox-1",
        toInboxId: "inbox-5",
      }),
    );
  });
});
