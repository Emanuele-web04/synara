import { ProjectId, SpaceId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSpacesUiStore } from "./spacesUiStore";

describe("spacesUiStore", () => {
  beforeEach(() => {
    const entries = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        clear: () => entries.clear(),
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => entries.set(key, value),
      },
    });
    useSpacesUiStore.setState({
      activeSpaceId: null,
      lastThreadIdBySpace: {},
      lastProjectIdBySpace: {},
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("stores independent last-thread targets for Void and custom spaces", () => {
    const workSpaceId = SpaceId.makeUnsafe("space-work");
    const voidThreadId = ThreadId.makeUnsafe("thread-void");
    const workThreadId = ThreadId.makeUnsafe("thread-work");

    useSpacesUiStore.getState().rememberThread(null, voidThreadId);
    useSpacesUiStore.getState().rememberThread(workSpaceId, workThreadId);

    expect(useSpacesUiStore.getState().getLastThreadId(null)).toBe(voidThreadId);
    expect(useSpacesUiStore.getState().getLastThreadId(workSpaceId)).toBe(workThreadId);
  });

  it("falls back to Void and prunes stale restoration targets", () => {
    const removedSpaceId = SpaceId.makeUnsafe("space-removed");
    const voidProjectId = ProjectId.makeUnsafe("project-void");
    const removedProjectId = ProjectId.makeUnsafe("project-removed");
    const voidThreadId = ThreadId.makeUnsafe("thread-void");
    const removedThreadId = ThreadId.makeUnsafe("thread-removed");
    useSpacesUiStore.setState({
      activeSpaceId: removedSpaceId,
      lastThreadIdBySpace: {
        void: voidThreadId,
        [removedSpaceId]: removedThreadId,
      },
      lastProjectIdBySpace: {},
    });

    useSpacesUiStore.getState().reconcile({
      activeSpaceIds: new Set(),
      projectSpaceById: new Map([
        [voidProjectId, null],
        [removedProjectId, null],
      ]),
      threadProjectById: new Map([
        [voidThreadId, voidProjectId],
        [removedThreadId, removedProjectId],
      ]),
    });

    expect(useSpacesUiStore.getState().activeSpaceId).toBeNull();
    expect(useSpacesUiStore.getState().lastThreadIdBySpace).toEqual({ void: voidThreadId });
  });

  it("keeps only the most recent project-or-thread target per space", () => {
    const workSpaceId = SpaceId.makeUnsafe("space-work");
    const projectId = ProjectId.makeUnsafe("project-work");
    const threadId = ThreadId.makeUnsafe("thread-work");

    useSpacesUiStore.getState().rememberThread(workSpaceId, threadId);
    useSpacesUiStore.getState().rememberProject(workSpaceId, projectId);
    expect(useSpacesUiStore.getState().getLastThreadId(workSpaceId)).toBeNull();
    expect(useSpacesUiStore.getState().getLastProjectId(workSpaceId)).toBe(projectId);

    useSpacesUiStore.getState().rememberThread(workSpaceId, threadId);
    expect(useSpacesUiStore.getState().getLastProjectId(workSpaceId)).toBeNull();
    expect(useSpacesUiStore.getState().getLastThreadId(workSpaceId)).toBe(threadId);
  });
});
