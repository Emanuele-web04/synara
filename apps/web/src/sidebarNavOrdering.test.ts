// FILE: sidebarNavOrdering.test.ts
// Purpose: Keeps primary sidebar nav ordering normalization covered for every nav item.
// Layer: Web settings tests

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SIDEBAR_NAV_ORDER,
  isSidebarNavItemId,
  normalizeHiddenSidebarNavItems,
  normalizeSidebarNavOrder,
  SIDEBAR_NAV_ITEM_IDS,
} from "./sidebarNavOrdering";

describe("sidebarNavOrdering", () => {
  it("includes every nav item in the default order exactly once", () => {
    expect(DEFAULT_SIDEBAR_NAV_ORDER).toHaveLength(SIDEBAR_NAV_ITEM_IDS.length);
    expect(new Set(DEFAULT_SIDEBAR_NAV_ORDER)).toEqual(new Set(SIDEBAR_NAV_ITEM_IDS));
  });

  it("keeps persisted order while appending newly shipped items at the end", () => {
    expect(normalizeSidebarNavOrder(["automations", "newThread", "inbox"])).toEqual([
      "automations",
      "newThread",
      "inbox",
      "kanban",
      "pullRequests",
    ]);
  });

  it("slots Inbox under New thread in an order saved before it shipped", () => {
    expect(normalizeSidebarNavOrder(["automations", "newThread", "kanban"])).toEqual([
      "automations",
      "newThread",
      "inbox",
      "kanban",
      "pullRequests",
    ]);
    // Once saved, the user's placement wins.
    expect(normalizeSidebarNavOrder(["inbox", "newThread"]).slice(0, 2)).toEqual([
      "inbox",
      "newThread",
    ]);
  });

  it("drops unknown and duplicate entries from persisted values", () => {
    expect(isSidebarNavItemId("bogus")).toBe(false);
    expect(normalizeSidebarNavOrder(["kanban", "bogus", "kanban"])).toEqual([
      "kanban",
      "newThread",
      "inbox",
      "pullRequests",
      "automations",
    ]);
    expect(normalizeHiddenSidebarNavItems(["bogus", "kanban", "kanban"])).toEqual(["kanban"]);
  });
});
