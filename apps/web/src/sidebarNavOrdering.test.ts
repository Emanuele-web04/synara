// FILE: sidebarNavOrdering.test.ts
// Purpose: Keeps primary sidebar nav ordering normalization covered for every nav item.
// Layer: Web settings tests

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SIDEBAR_NAV_ORDER,
  isSidebarNavItemId,
  normalizeHiddenSidebarNavItems,
  normalizeSidebarNavOrder,
  resolveTasksSurfaceSlot,
  SIDEBAR_NAV_ITEM_IDS,
} from "./sidebarNavOrdering";

describe("sidebarNavOrdering", () => {
  it("includes every nav item in the default order exactly once", () => {
    expect(DEFAULT_SIDEBAR_NAV_ORDER).toHaveLength(SIDEBAR_NAV_ITEM_IDS.length);
    expect(new Set(DEFAULT_SIDEBAR_NAV_ORDER)).toEqual(new Set(SIDEBAR_NAV_ITEM_IDS));
  });

  it("keeps persisted order while appending newly shipped items at the end", () => {
    expect(normalizeSidebarNavOrder(["automations", "newThread"])).toEqual([
      "automations",
      "newThread",
      "kanban",
      "tasks",
      "pullRequests",
    ]);
  });

  it("drops unknown and duplicate entries from persisted values", () => {
    expect(isSidebarNavItemId("bogus")).toBe(false);
    expect(normalizeSidebarNavOrder(["kanban", "bogus", "kanban"])).toEqual([
      "kanban",
      "newThread",
      "tasks",
      "pullRequests",
      "automations",
    ]);
    expect(normalizeHiddenSidebarNavItems(["bogus", "kanban", "kanban"])).toEqual(["kanban"]);
  });
});

describe("resolveTasksSurfaceSlot", () => {
  it("shows Tasks where Beta has it and Kanban elsewhere, in the first of their slots", () => {
    const order = ["newThread", "pullRequests", "kanban", "automations", "tasks"] as const;
    expect(resolveTasksSurfaceSlot(order, true)).toEqual([
      "newThread",
      "pullRequests",
      "tasks",
      "automations",
    ]);
    expect(resolveTasksSurfaceSlot(order, false)).toEqual([
      "newThread",
      "pullRequests",
      "kanban",
      "automations",
    ]);
  });

  it("leaves an order without either item alone", () => {
    expect(resolveTasksSurfaceSlot(["newThread", "automations"], true)).toEqual([
      "newThread",
      "automations",
    ]);
  });
});
