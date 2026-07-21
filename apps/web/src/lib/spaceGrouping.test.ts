import { SpaceId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { Space } from "~/types";
import { resolveActiveSpaceId } from "./spaceGrouping";

const workSpaceId = SpaceId.makeUnsafe("space-work");
const workSpace: Space = {
  id: workSpaceId,
  name: "Work",
  icon: "bag",
  sortOrder: 0,
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
};

describe("resolveActiveSpaceId", () => {
  it("keeps known selections and resolves stale persisted ids to Void", () => {
    expect(resolveActiveSpaceId(workSpaceId, [workSpace])).toBe(workSpaceId);
    expect(resolveActiveSpaceId(SpaceId.makeUnsafe("space-deleted"), [workSpace])).toBeNull();
    expect(resolveActiveSpaceId(null, [workSpace])).toBeNull();
  });

  it("keeps a receipt-fenced optimistic selection until shell hydration catches up", () => {
    const pendingSpaceId = SpaceId.makeUnsafe("space-pending");

    expect(resolveActiveSpaceId(pendingSpaceId, [workSpace], pendingSpaceId)).toBe(
      pendingSpaceId,
    );
  });
});
