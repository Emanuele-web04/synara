import { assert, describe, it } from "vitest";

import { buildGroupDeletedNotice } from "./groupLifecycle.logic";

describe("buildGroupDeletedNotice", () => {
  it("returns null when nothing was left on disk", () => {
    assert.equal(
      buildGroupDeletedNotice({
        libraryLeftOnDiskPath: null,
        workspaceLeftOnDiskPath: null,
      }),
      null,
    );
  });

  it("describes a kept library with one copyable path", () => {
    const notice = buildGroupDeletedNotice({
      libraryLeftOnDiskPath: "/Users/a/Documents/Synara/Groups/crew/Library",
      workspaceLeftOnDiskPath: null,
    });
    assert.equal(
      notice?.description.includes("/Users/a/Documents/Synara/Groups/crew/Library"),
      true,
    );
    assert.deepEqual(notice?.copyItems, [
      { label: "library path", text: "/Users/a/Documents/Synara/Groups/crew/Library" },
    ]);
  });

  it("explains why the group folder was kept", () => {
    const notice = buildGroupDeletedNotice({
      libraryLeftOnDiskPath: null,
      workspaceLeftOnDiskPath: "/Users/a/Documents/Synara/Groups/crew",
    });
    assert.equal(notice?.description.includes("has your files"), true);
    assert.equal(notice?.description.includes("/Users/a/Documents/Synara/Groups/crew"), true);
    assert.deepEqual(notice?.copyItems, [
      { label: "group folder path", text: "/Users/a/Documents/Synara/Groups/crew" },
    ]);
  });

  it("merges both kept paths into one notice, each with its own copy item", () => {
    const notice = buildGroupDeletedNotice({
      libraryLeftOnDiskPath: "/kept/library",
      workspaceLeftOnDiskPath: "/kept/group-folder",
    });
    assert.equal(notice?.description.includes("/kept/library"), true);
    assert.equal(notice?.description.includes("/kept/group-folder"), true);
    assert.deepEqual(notice?.copyItems, [
      { label: "library path", text: "/kept/library" },
      { label: "group folder path", text: "/kept/group-folder" },
    ]);
  });
});
