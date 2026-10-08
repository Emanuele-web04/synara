import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  EMPTY_DOCK_EXPLORER_BROWSE_STATE,
  selectDockExplorerBrowseState,
  useDockExplorerBrowseStore,
} from "./dockExplorerBrowseStore";

const threadA = ThreadId.makeUnsafe("thread-a");
const threadB = ThreadId.makeUnsafe("thread-b");

beforeEach(() => {
  useDockExplorerBrowseStore.setState({ browseStateByThreadId: {} });
});

describe("dockExplorerBrowseStore", () => {
  it("keeps each thread's browse state independent", () => {
    const store = useDockExplorerBrowseStore.getState();
    store.selectFile(threadA, "src/a.ts");
    store.expandDirectories(threadA, ["src"]);
    store.setSearchQuery(threadA, "read");

    store.selectFile(threadB, "docs/b.md");

    const stateA = selectDockExplorerBrowseState(threadA)(useDockExplorerBrowseStore.getState());
    const stateB = selectDockExplorerBrowseState(threadB)(useDockExplorerBrowseStore.getState());
    expect(stateA).toEqual({
      selectedFilePath: "src/a.ts",
      expandedDirectories: new Set(["src"]),
      searchQuery: "read",
    });
    expect(stateB).toEqual({
      selectedFilePath: "docs/b.md",
      expandedDirectories: new Set(),
      searchQuery: "",
    });
  });

  it("toggles directories independently per thread", () => {
    const store = useDockExplorerBrowseStore.getState();
    store.toggleDirectory(threadA, "src");
    store.toggleDirectory(threadA, "src/inner");
    store.toggleDirectory(threadA, "src");

    expect(
      selectDockExplorerBrowseState(threadA)(useDockExplorerBrowseStore.getState())
        .expandedDirectories,
    ).toEqual(new Set(["src/inner"]));
  });

  it("returns the shared empty snapshot for unvisited threads", () => {
    const state = useDockExplorerBrowseStore.getState();
    expect(selectDockExplorerBrowseState(threadA)(state)).toBe(EMPTY_DOCK_EXPLORER_BROWSE_STATE);
  });

  it("does not write store entries for no-op updates", () => {
    const store = useDockExplorerBrowseStore.getState();
    store.setSearchQuery(threadA, "");
    store.selectFile(threadA, null);
    store.expandDirectories(threadA, []);

    expect(useDockExplorerBrowseStore.getState().browseStateByThreadId).toEqual({});
  });
});
