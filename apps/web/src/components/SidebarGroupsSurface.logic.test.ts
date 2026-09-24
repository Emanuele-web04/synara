import { ProjectId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  isDefaultGroupCoordinatorName,
  resolveGroupCoordinatorDisplayName,
} from "../lib/groupCoordinatorName";
import {
  activateThreadWhenHydrated,
  resolveGroupChatTargetProjectId,
  resolveGroupCoordinatorRowLabel,
  resolveGroupsListEmptyState,
} from "./SidebarGroupsSurface.logic";

const GROUP_A = ProjectId.makeUnsafe("group-a");
const GROUP_B = ProjectId.makeUnsafe("group-b");
const ORDINARY = ProjectId.makeUnsafe("project-ordinary");

describe("resolveGroupCoordinatorRowLabel", () => {
  it("shows the configured coordinator name", () => {
    expect(
      resolveGroupCoordinatorRowLabel({
        configured: true,
        coordinatorName: "Group lead",
        groupName: "Alpha",
      }),
    ).toBe("Group lead");
  });

  it("defaults to the group name when the stored name is the generated default", () => {
    expect(
      resolveGroupCoordinatorRowLabel({
        configured: true,
        coordinatorName: "Alpha Coordinator",
        groupName: "Alpha",
      }),
    ).toBe("Alpha");
    expect(
      resolveGroupCoordinatorRowLabel({
        configured: true,
        coordinatorName: "  ",
        groupName: "Alpha",
      }),
    ).toBe("Alpha");
    expect(
      resolveGroupCoordinatorRowLabel({
        configured: true,
        coordinatorName: null,
        groupName: "Alpha",
      }),
    ).toBe("Alpha");
  });

  it("falls back to the setup label when unconfigured", () => {
    expect(
      resolveGroupCoordinatorRowLabel({
        configured: false,
        coordinatorName: null,
        groupName: "Alpha",
      }),
    ).toBe("Set up coordinator");
  });
});

describe("resolveGroupCoordinatorDisplayName", () => {
  it("maps the legacy '<title> Coordinator' default onto the group name", () => {
    expect(
      resolveGroupCoordinatorDisplayName({
        coordinatorName: "Building Mars Coordinator",
        groupName: "Building Mars",
        remoteName: "Building Mars",
      }),
    ).toBe("Building Mars");
  });

  it("keeps a user-chosen name and a user-renamed thread title", () => {
    expect(
      resolveGroupCoordinatorDisplayName({
        coordinatorName: "Team lead",
        groupName: "Alpha",
        remoteName: "alpha",
      }),
    ).toBe("Team lead");
    expect(
      resolveGroupCoordinatorDisplayName({
        coordinatorName: "Alpha Coordinator",
        groupName: "Alpha",
        remoteName: "Alpha",
        threadTitle: "Bobby",
      }),
    ).toBe("Bobby");
  });
});

describe("isDefaultGroupCoordinatorName", () => {
  it("treats both default shapes as generated", () => {
    expect(isDefaultGroupCoordinatorName("Alpha", ["Alpha"])).toBe(true);
    expect(isDefaultGroupCoordinatorName("Alpha Coordinator", ["Alpha"])).toBe(true);
    expect(isDefaultGroupCoordinatorName(null, ["Alpha"])).toBe(true);
    expect(isDefaultGroupCoordinatorName("Team lead", ["Alpha"])).toBe(false);
  });
});

describe("resolveGroupsListEmptyState", () => {
  it("is loading before threads hydrate", () => {
    expect(resolveGroupsListEmptyState({ threadsHydrated: false, groupCount: 0 })).toBe("loading");
    expect(resolveGroupsListEmptyState({ threadsHydrated: false, groupCount: 2 })).toBe("loading");
  });

  it("reports no groups once hydrated and none exist", () => {
    expect(resolveGroupsListEmptyState({ threadsHydrated: true, groupCount: 0 })).toBe("no-groups");
    expect(resolveGroupsListEmptyState({ threadsHydrated: true, groupCount: 1 })).toBeNull();
  });
});

describe("resolveGroupChatTargetProjectId", () => {
  it("targets the active project when it is a group", () => {
    expect(
      resolveGroupChatTargetProjectId({
        activeProject: { id: GROUP_B },
        groupProjects: [{ id: GROUP_A }, { id: GROUP_B }],
      }),
    ).toBe(GROUP_B);
  });

  it("falls back to the first group when the active project is ordinary or absent", () => {
    expect(
      resolveGroupChatTargetProjectId({
        activeProject: { id: ORDINARY },
        groupProjects: [{ id: GROUP_A }, { id: GROUP_B }],
      }),
    ).toBe(GROUP_A);
    expect(
      resolveGroupChatTargetProjectId({
        activeProject: null,
        groupProjects: [{ id: GROUP_B }],
      }),
    ).toBe(GROUP_B);
  });

  it("returns null when no group exists", () => {
    expect(resolveGroupChatTargetProjectId({ activeProject: null, groupProjects: [] })).toBeNull();
  });
});

describe("activateThreadWhenHydrated", () => {
  it("activates immediately when the thread is already hydrated", () => {
    let activated = 0;
    activateThreadWhenHydrated({
      hasThread: () => true,
      activate: () => {
        activated += 1;
      },
    });
    expect(activated).toBe(1);
  });

  it("activates via the poll fallback once the thread appears", async () => {
    let present = false;
    let activated = 0;
    setTimeout(() => {
      present = true;
    }, 30);
    activateThreadWhenHydrated({
      hasThread: () => present,
      activate: () => {
        activated += 1;
      },
      pollMs: 10,
    });
    await vi.waitFor(() => {
      expect(activated).toBe(1);
    });
  });

  it("activates on the store notification before the next poll", () => {
    let present = false;
    let activated = 0;
    const listeners: (() => void)[] = [];
    activateThreadWhenHydrated({
      hasThread: () => present,
      activate: () => {
        activated += 1;
      },
      subscribe: (notify) => {
        listeners.push(notify);
        return () => {
          listeners.length = 0;
        };
      },
      pollMs: 60_000,
      maxWaitMs: 60_000,
    });
    expect(activated).toBe(0);
    present = true;
    listeners[0]?.();
    expect(activated).toBe(1);
  });

  it("gives up without activating when the thread never appears", async () => {
    let activated = 0;
    activateThreadWhenHydrated({
      hasThread: () => false,
      activate: () => {
        activated += 1;
      },
      pollMs: 5,
      maxWaitMs: 25,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(activated).toBe(0);
  });
});
