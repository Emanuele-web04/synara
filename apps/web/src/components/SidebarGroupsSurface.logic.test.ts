import { ProjectId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

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
      resolveGroupCoordinatorRowLabel({ configured: true, coordinatorName: "Group lead" }),
    ).toBe("Group lead");
  });

  it("falls back to the setup label when unconfigured or unnamed", () => {
    expect(resolveGroupCoordinatorRowLabel({ configured: false, coordinatorName: null })).toBe(
      "Set up coordinator",
    );
    expect(resolveGroupCoordinatorRowLabel({ configured: true, coordinatorName: "  " })).toBe(
      "Set up coordinator",
    );
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
  it("activates immediately when the thread is already hydrated", async () => {
    let activated = 0;
    await expect(
      activateThreadWhenHydrated({
        hasThread: () => true,
        activate: () => {
          activated += 1;
        },
      }),
    ).resolves.toBe(true);
    expect(activated).toBe(1);
  });

  it("waits for the thread to appear before activating", async () => {
    let present = false;
    let activated = 0;
    setTimeout(() => {
      present = true;
    }, 30);
    await expect(
      activateThreadWhenHydrated({
        hasThread: () => present,
        activate: () => {
          activated += 1;
        },
        delayMs: 10,
      }),
    ).resolves.toBe(true);
    expect(activated).toBe(1);
  });

  it("gives up without activating when the thread never appears", async () => {
    let activated = 0;
    await expect(
      activateThreadWhenHydrated({
        hasThread: () => false,
        activate: () => {
          activated += 1;
        },
        maxAttempts: 3,
        delayMs: 1,
      }),
    ).resolves.toBe(false);
    expect(activated).toBe(0);
  });
});
