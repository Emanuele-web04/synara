import { SpaceId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { Space } from "~/types";
import {
  DEFAULT_VOID_SPACE,
  groupItemsBySpace,
  resolveActiveSpaceId,
  spaceDisplayIcon,
  spaceDisplayName,
  type VoidSpacePresentation,
} from "./spaceGrouping";

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

    expect(resolveActiveSpaceId(pendingSpaceId, [workSpace], pendingSpaceId)).toBe(pendingSpaceId);
  });
});

describe("the unfiled group's presentation", () => {
  const renamedVoid: VoidSpacePresentation = { name: "Da ordinare", icon: "backpack" };

  it("renders the user's name and icon wherever Void would be named", () => {
    expect(spaceDisplayName(null, [workSpace])).toBe(DEFAULT_VOID_SPACE.name);
    expect(spaceDisplayIcon(null, [workSpace])).toBe(DEFAULT_VOID_SPACE.icon);
    expect(spaceDisplayName(null, [workSpace], renamedVoid)).toBe("Da ordinare");
    expect(spaceDisplayIcon(null, [workSpace], renamedVoid)).toBe("backpack");
  });

  it("leaves stored spaces alone, and falls back for a space the snapshot lost", () => {
    const staleSpaceId = SpaceId.makeUnsafe("space-deleted");

    expect(spaceDisplayName(workSpaceId, [workSpace], renamedVoid)).toBe("Work");
    expect(spaceDisplayIcon(workSpaceId, [workSpace], renamedVoid)).toBe("bag");
    expect(spaceDisplayName(staleSpaceId, [workSpace], renamedVoid)).toBe("Unknown space");
    expect(spaceDisplayIcon(staleSpaceId, [workSpace], renamedVoid)).toBe("backpack");
  });

  it("labels the grouped unfiled bucket with it too", () => {
    const groups = groupItemsBySpace({
      items: [{ spaceId: null }, { spaceId: workSpaceId }],
      spaces: [workSpace],
      activeSpaceId: null,
      spaceIdOf: (item) => item.spaceId,
      voidSpace: renamedVoid,
    });

    expect(groups.map((group) => group.label)).toEqual(["Da ordinare · Active", "Work"]);
    expect(groups[0]?.icon).toBe("backpack");
    expect(groups[0]?.key).toBe("void");
  });
});
