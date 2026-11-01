import { SpaceId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguagePreference } from "~/i18n";

afterEach(() => setLanguagePreference("system"));

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

  it.each([
    ["en", "Unknown space"],
    ["zh-CN", "未知空间"],
  ] as const)(
    "leaves stored spaces alone and localizes the missing-space fallback in %s",
    (locale, unknownName) => {
      setLanguagePreference(locale);
      const staleSpaceId = SpaceId.makeUnsafe("space-deleted");

      expect(spaceDisplayName(workSpaceId, [workSpace], renamedVoid)).toBe("Work");
      expect(spaceDisplayIcon(workSpaceId, [workSpace], renamedVoid)).toBe("bag");
      expect(spaceDisplayName(staleSpaceId, [workSpace], renamedVoid)).toBe(unknownName);
      expect(spaceDisplayIcon(staleSpaceId, [workSpace], renamedVoid)).toBe("backpack");
    },
  );

  it.each([
    ["en", "Da ordinare · Active"],
    ["zh-CN", "Da ordinare · 当前空间"],
  ] as const)(
    "labels the grouped unfiled bucket in %s without changing its name or identity",
    (locale, activeLabel) => {
      setLanguagePreference(locale);
      const groups = groupItemsBySpace({
        items: [{ spaceId: null }, { spaceId: workSpaceId }],
        spaces: [workSpace],
        activeSpaceId: null,
        spaceIdOf: (item) => item.spaceId,
        voidSpace: renamedVoid,
      });

      expect(groups.map((group) => group.label)).toEqual([activeLabel, "Work"]);
      expect(groups.map((group) => group.name)).toEqual(["Da ordinare", "Work"]);
      expect(groups.map((group) => group.spaceId)).toEqual([null, workSpaceId]);
      expect(groups.flatMap((group) => group.items)).toEqual([
        { spaceId: null },
        { spaceId: workSpaceId },
      ]);
      expect(groups[0]?.icon).toBe("backpack");
      expect(groups[0]?.key).toBe("void");
    },
  );
});
