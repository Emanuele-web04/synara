import { ProjectId, SpaceId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_VOID_SPACE } from "./lib/spaceGrouping";
import type { Space } from "./types";
import {
  buildRailRouteItemOrder,
  buildRailSpacesSections,
  railItemShowsPanel,
  railProjectShortcutKey,
  railSpaceShortcutKey,
  resolveActiveRailShortcutKey,
  resolveRailShortcuts,
  toggleRailShortcutKey,
  railItemForPathname,
  reconcileActiveRailItem,
} from "./appRail.logic";

describe("buildRailRouteItemOrder", () => {
  it("follows the persisted nav order without New thread", () => {
    expect(
      buildRailRouteItemOrder({
        navOrder: ["automations", "newThread", "kanban", "pullRequests"],
        hidden: new Set(),
        activeNavId: null,
      }),
    ).toEqual(["automations", "kanban", "pullRequests"]);
  });

  it("drops hidden items unless their route is active", () => {
    expect(
      buildRailRouteItemOrder({
        navOrder: ["newThread", "kanban", "pullRequests", "automations"],
        hidden: new Set(["kanban", "automations"]),
        activeNavId: "automations",
      }),
    ).toEqual(["pullRequests", "automations"]);
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
    expect(railItemShowsPanel("pullRequests")).toBe(false);
    for (const id of ["home", "spaces", "automations", "studio", "settings"] as const) {
      expect(railItemShowsPanel(id)).toBe(true);
    }
  });
});

describe("railItemForPathname", () => {
  it("maps route prefixes to their rail item and everything else to null", () => {
    expect(railItemForPathname("/kanban")).toBe("kanban");
    expect(railItemForPathname("/pull-requests/42")).toBe("pullRequests");
    expect(railItemForPathname("/automations")).toBe("automations");
    expect(railItemForPathname("/studio/abc")).toBe("studio");
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
