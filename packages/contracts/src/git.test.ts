import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  GitFileChangeType,
  GitReadWorkingTreeDiffInput,
  GitStatusLocalResult,
  GitStatusResult,
  GitStatusStreamEvent,
} from "./git";

describe("GitReadWorkingTreeDiffInput", () => {
  it("preserves the optional literal file path through the RPC schema", () => {
    const decode = Schema.decodeUnknownSync(GitReadWorkingTreeDiffInput);
    expect(decode({ cwd: "/repo", scope: "workingTree", filePath: "src/[name].ts" })).toMatchObject(
      {
        cwd: "/repo",
        scope: "workingTree",
        filePath: "src/[name].ts",
      },
    );
    expect(decode({ cwd: "/repo" })).not.toHaveProperty("filePath");
  });
});

describe("Git status file change types", () => {
  const local = {
    branch: "main",
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "src/file.ts", insertions: 0, deletions: 0 }],
      insertions: 0,
      deletions: 0,
    },
  };
  const result = {
    ...local,
    hasUpstream: false,
    upstreamBranch: null,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  };

  it("accepts older status responses without a change type", () => {
    const decoded = Schema.decodeUnknownSync(GitStatusResult)(result);
    expect(decoded.workingTree.files[0]).not.toHaveProperty("changeType");
    expect(Schema.decodeUnknownSync(GitStatusLocalResult)(local)).toEqual(local);
  });

  it.each([
    "added",
    "untracked",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "unmerged",
    "type-changed",
  ])("retains authoritative %s through full, local, and streamed status schemas", (changeType) => {
    const workingTree = {
      ...local.workingTree,
      files: [{ ...local.workingTree.files[0]!, changeType }],
    };
    expect(Schema.decodeUnknownSync(GitFileChangeType)(changeType)).toBe(changeType);
    expect(
      Schema.decodeUnknownSync(GitStatusResult)({ ...result, workingTree }).workingTree.files[0]
        ?.changeType,
    ).toBe(changeType);
    for (const event of [
      { _tag: "snapshot", local: { ...local, workingTree }, remote: null },
      { _tag: "localUpdated", local: { ...local, workingTree } },
    ]) {
      expect(
        Schema.encodeUnknownSync(GitStatusStreamEvent)(
          Schema.decodeUnknownSync(GitStatusStreamEvent)(event),
        ),
      ).toEqual(event);
    }
  });

  it("preserves whitespace, tabs, and newlines in opaque file paths", () => {
    const path = " \t leading\ntrailing.txt \t";
    const input = {
      ...local,
      workingTree: {
        ...local.workingTree,
        files: [{ path, insertions: 0, deletions: 0, changeType: "untracked" }],
      },
    };
    expect(
      Schema.encodeUnknownSync(GitStatusLocalResult)(
        Schema.decodeUnknownSync(GitStatusLocalResult)(input),
      ),
    ).toEqual(input);
  });

  it("rejects empty paths and invalid change types rather than inventing a status", () => {
    const decode = Schema.decodeUnknownSync(GitStatusLocalResult);
    for (const file of [
      { path: "", insertions: 0, deletions: 0 },
      { path: "file", insertions: 0, deletions: 0, changeType: "clean" },
    ])
      expect(() =>
        decode({ ...local, workingTree: { ...local.workingTree, files: [file] } }),
      ).toThrow();
  });
});
