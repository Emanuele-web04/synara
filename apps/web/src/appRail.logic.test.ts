import { ProjectId, SpaceId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_VOID_SPACE } from "./lib/spaceGrouping";
import type { Space } from "./types";
import {
  buildRailItemOrder,
  buildRailSpacesSections,
  railItemShowsPanel,
  railProjectShortcutKey,
  railSpaceShortcutKey,
  resolveActiveRailShortcutKey,
  resolveRailShortcuts,
  toggleRailShortcutKey,
  railItemForPathname,
  reconcileActiveRailItem,
  normalizeHiddenRailItems,
  normalizeRailItemOrder,
  isRailItemAvailable,
  RAIL_ORDERABLE_ITEM_IDS,
} from "./appRail.logic";

describe("rail item order", () => {
  it("completes a saved order with new items and drops unknown or duplicate ids", () => {
    expect(normalizeRailItemOrder(["automations", "gone", "home", "automations"])).toEqual([
      "automations",
      "home",
      "inbox",
      "spaces",
      "kanban",
      "tasks",
      "pullRequests",
      "mind",
      "studio",
    ]);
  });

  it("slots Inbox next to Home in orders saved before it shipped, then keeps its place", () => {
    expect(normalizeRailItemOrder(["kanban", "home", "spaces"])).toEqual([
      "kanban",
      "home",
      "inbox",
      "spaces",
      "tasks",
      "pullRequests",
      "automations",
      "mind",
      "studio",
    ]);
    expect(normalizeRailItemOrder(["home", "spaces", "inbox"]).slice(0, 3)).toEqual([
      "home",
      "spaces",
      "inbox",
    ]);
  });

  it("never keeps Home hidden", () => {
    expect(normalizeHiddenRailItems(["home", "kanban", "gone", "kanban"])).toEqual(["kanban"]);
  });

  it("drops hidden items unless active, and Studio or Inbox unless available", () => {
    const order = normalizeRailItemOrder([]);
    expect(
      buildRailItemOrder({
        order,
        hidden: new Set(["spaces", "automations"]),
        activeItem: "automations",
        studioAvailable: false,
        inboxAvailable: false,
      }),
    ).toEqual(["home", "kanban", "tasks", "pullRequests", "automations", "mind"]);
    expect(
      buildRailItemOrder({
        order,
        hidden: new Set(),
        activeItem: "home",
        studioAvailable: true,
        inboxAvailable: true,
      }),
    ).toEqual(order);
  });

  it("offers Inbox and Studio in Customize only where they exist", () => {
    const stable = { studioAvailable: false, inboxAvailable: false };
    expect(RAIL_ORDERABLE_ITEM_IDS.filter((id) => isRailItemAvailable(id, stable))).toEqual([
      "home",
      "spaces",
      "kanban",
      "tasks",
      "pullRequests",
      "automations",
      "mind",
    ]);
    expect(isRailItemAvailable("inbox", { studioAvailable: false, inboxAvailable: true })).toBe(
      true,
    );
  });
});

describe("rail shortcuts", () => {
  const work = SpaceId.makeUnsafe("space-work");
  const alpha = ProjectId.makeUnsafe("project-alpha");

  it("keeps saved shortcuts that still exist, in order, without duplicates", () => {
    const shortcuts = resolveRailShortcuts({
      keys: [
        railProjectShortcutKey(alpha),
        railSpaceShortcutKey(null),
        "space:gone",
        railProjectShortcutKey(alpha),
        railSpaceShortcutKey(work),
      ],
      spaceIds: new Set([work]),
      projectIds: new Set([alpha]),
    });
    expect(shortcuts.map((shortcut) => shortcut.key)).toEqual([
      railProjectShortcutKey(alpha),
      railSpaceShortcutKey(null),
      railSpaceShortcutKey(work),
    ]);
  });

  it("toggles a shortcut in and out at the end of the rail", () => {
    const key = railSpaceShortcutKey(work);
    expect(toggleRailShortcutKey(["a"], key)).toEqual(["a", key]);
    expect(toggleRailShortcutKey(["a", key], key)).toEqual(["a"]);
  });

  it("marks the shortcut that matches what the panel shows", () => {
    const shortcuts = resolveRailShortcuts({
      keys: [railSpaceShortcutKey(work), railProjectShortcutKey(alpha)],
      spaceIds: new Set([work]),
      projectIds: new Set([alpha]),
    });
    const base = { shortcuts, activeSpaceId: work, spacesProjectId: alpha };
    expect(resolveActiveRailShortcutKey({ ...base, activeItem: "home" })).toBe(
      railSpaceShortcutKey(work),
    );
    expect(resolveActiveRailShortcutKey({ ...base, activeItem: "spaces" })).toBe(
      railProjectShortcutKey(alpha),
    );
    expect(resolveActiveRailShortcutKey({ ...base, activeItem: "kanban" })).toBeNull();
  });
});

describe("railItemShowsPanel", () => {
  it("hides the panel only for the full-width sections", () => {
    expect(railItemShowsPanel("kanban")).toBe(false);
    expect(railItemShowsPanel("tasks")).toBe(false);
    expect(railItemShowsPanel("pullRequests")).toBe(false);
    expect(railItemShowsPanel("inbox")).toBe(false);
    for (const id of ["home", "spaces", "automations", "studio", "settings"] as const) {
      expect(railItemShowsPanel(id)).toBe(true);
    }
  });
});

describe("railItemForPathname", () => {
  it("maps route prefixes to their rail item and everything else to null", () => {
    expect(railItemForPathname("/inbox")).toBe("inbox");
    expect(railItemForPathname("/kanban")).toBe("kanban");
    expect(railItemForPathname("/tasks")).toBe("tasks");
    expect(railItemForPathname("/pull-requests/42")).toBe("pullRequests");
    expect(railItemForPathname("/automations")).toBe("automations");
    expect(railItemForPathname("/mind")).toBe("mind");
    expect(railItemForPathname("/mindfulness")).toBeNull();
    expect(railItemForPathname("/studio/abc")).toBe("studio");
    expect(railItemForPathname("/groups")).toBe("studio");
    expect(railItemForPathname("/hubs")).toBe("studio");
    expect(railItemForPathname("/hubs/alpha")).toBe("studio");
    expect(railItemForPathname("/hubsish")).toBeNull();
    expect(railItemForPathname("/settings")).toBe("settings");
    expect(railItemForPathname("/kanbanish")).toBeNull();
    expect(railItemForPathname("/")).toBeNull();
    expect(railItemForPathname("/thread-1")).toBeNull();
  });
});

describe("reconcileActiveRailItem", () => {
  it("lets a route match win and otherwise falls back to the current panel", () => {
    const base = { onStudioSurface: false, panelView: "spaces" } as const;
    expect(reconcileActiveRailItem({ ...base, current: "spaces", pathname: "/kanban" })).toBe(
      "kanban",
    );
    expect(reconcileActiveRailItem({ ...base, current: "kanban", pathname: "/thread-1" })).toBe(
      "spaces",
    );
  });

  it("keeps Studio active on a Studio thread's plain thread path", () => {
    expect(
      reconcileActiveRailItem({
        current: "studio",
        pathname: "/thread-1",
        onStudioSurface: true,
        panelView: "home",
      }),
    ).toBe("studio");
  });
});

describe("buildRailSpacesSections", () => {
  const work = SpaceId.makeUnsafe("space-work");
  const home = SpaceId.makeUnsafe("space-home");
  const spaces = [
    { id: work, name: "Work" },
    { id: home, name: "Home" },
  ] as unknown as Space[];

  it("orders the active space first, keeps empty spaces, and drops an empty Void", () => {
    const sections = buildRailSpacesSections({
      items: [{ id: "a", spaceId: work }],
      spaces,
      activeSpaceId: home,
      spaceIdOf: (item) => item.spaceId,
      voidSpace: DEFAULT_VOID_SPACE,
    });
    expect(sections.map((section) => [section.name, section.items.length])).toEqual([
      ["Home", 0],
      ["Work", 1],
    ]);
  });

  it("falls back to a single Void section when there is nothing else", () => {
    const sections = buildRailSpacesSections({
      items: [] as { spaceId: SpaceId | null }[],
      spaces: [],
      activeSpaceId: null,
      spaceIdOf: (item) => item.spaceId,
      voidSpace: DEFAULT_VOID_SPACE,
    });
    expect(sections.map((section) => section.name)).toEqual([DEFAULT_VOID_SPACE.name]);
  });
});
