import { describe, expect, it } from "vitest";
import type { GitFileChangeType } from "@synara/contracts";

import {
  countTextFileLines,
  normalizeConfiguredMergeBranch,
  parseGitStatusPorcelain,
  resolveGitStatusChangeType,
  summarizeGitNumstatOutputs,
} from "./gitStatusParsing.ts";

const HASH = "a".repeat(40);

describe("git status parsing", () => {
  it("parses NUL porcelain metadata and adversarial paths without splitting records", () => {
    const deletedPath = "deleted\tfile\n.txt";
    const renamedPath = "renamed\tto\nfile.txt";
    const originalPath = "renamed\tfrom\nfile.txt";
    const untrackedPath = "new\tfile\n.txt";
    const stdout = [
      "# branch.oid " + HASH,
      "# branch.head feature/status",
      "# branch.upstream origin/feature/status",
      "# branch.ab +2 -3",
      `1 D. N... 100644 100644 000000 ${HASH} ${HASH} ${deletedPath}`,
      `2 R. N... 100644 100644 100644 ${HASH} ${HASH} R100 ${renamedPath}`,
      originalPath,
      `? ${untrackedPath}`,
      "? new-directory/",
      "",
    ].join("\0");

    const parsed = parseGitStatusPorcelain(stdout);

    expect(parsed).toMatchObject({
      branch: "feature/status",
      upstreamRef: "origin/feature/status",
      aheadCount: 2,
      behindCount: 3,
      hasWorkingTreeChanges: true,
      hasTrackedDeletion: true,
      hasUntrackedDirectory: true,
    });
    expect([...parsed.changedFilesWithoutNumstat]).toEqual([
      deletedPath,
      renamedPath,
      untrackedPath,
      "new-directory/",
    ]);
    expect([...parsed.untrackedFilesWithoutNumstat]).toEqual([untrackedPath, "new-directory/"]);
    expect(parsed.changedFilesWithoutNumstat.has(originalPath)).toBe(false);
    expect([...parsed.changeTypesByPath]).toEqual([
      [deletedPath, "deleted"],
      [renamedPath, "renamed"],
      [untrackedPath, "untracked"],
      ["new-directory/", "untracked"],
    ]);
  });

  it("normalizes only configured local merge refs", () => {
    expect(
      [" refs/heads/main\n", "feature/test", "  ", "refs/heads/"].map(
        normalizeConfiguredMergeBranch,
      ),
    ).toEqual(["main", "feature/test", null, null]);
  });

  it("aggregates combined numstat outputs, duplicate paths, renames, and binary files", () => {
    const renamedPath = "new\tname\n.txt";
    const summary = summarizeGitNumstatOutputs([
      ["2\t1\tduplicate.txt", "-\t-\tbinary.dat", ""].join("\0"),
      ["3\t4\tduplicate.txt", "5\t6\t", "old\tname\n.txt", renamedPath, ""].join("\0"),
    ]);

    expect(summary).toMatchObject({ insertions: 10, deletions: 11 });
    expect(summary.files).toHaveLength(3);
    expect(summary.files.find((file) => file.path === "duplicate.txt")).toEqual({
      path: "duplicate.txt",
      insertions: 5,
      deletions: 5,
    });
    expect(summary.files.find((file) => file.path === "binary.dat")).toEqual({
      path: "binary.dat",
      insertions: 0,
      deletions: 0,
    });
    expect(summary.files.find((file) => file.path === renamedPath)).toEqual({
      path: renamedPath,
      insertions: 5,
      deletions: 6,
    });
  });

  it("counts byte-level text lines and rejects binary content", () => {
    const encode = (value: string) => new TextEncoder().encode(value);

    expect(countTextFileLines(new Uint8Array())).toBe(0);
    expect(countTextFileLines(encode("first\nsecond\n"))).toBe(2);
    expect(countTextFileLines(encode("first\nsecond"))).toBe(2);
    expect(countTextFileLines(encode("unterminated"))).toBe(1);
    expect(countTextFileLines(new Uint8Array([0xff, 10, 0xfe]))).toBe(2);
    expect(countTextFileLines(new Uint8Array([65, 0, 66, 10]))).toBe(0);
  });

  it.each([
    ["A.", "added"],
    [".A", "added"],
    ["AM", "added"],
    ["M.", "modified"],
    [".M", "modified"],
    ["MM", "modified"],
    ["D.", "deleted"],
    [".D", "deleted"],
    ["AD", "deleted"],
    ["RD", "deleted"],
    ["R.", "renamed"],
    ["RM", "renamed"],
    ["C.", "copied"],
    ["CM", "copied"],
    ["T.", "type-changed"],
    [".T", "type-changed"],
    ["TM", "type-changed"],
    ["..", "modified"],
  ])("classifies porcelain %s independently of file counts as %s", (code, changeType) => {
    const renamed = code.includes("R") || code.includes("C");
    const path = " \tfile\n.txt ";
    const record = renamed
      ? `2 ${code} N... 100644 100644 100644 ${HASH} ${HASH} ${code.includes("C") ? "C" : "R"}100 ${path}\0# branch.head fake\0`
      : `1 ${code} ${code === ".." ? "S.M." : "N..."} 100644 100644 100644 ${HASH} ${HASH} ${path}\0`;
    const parsed = parseGitStatusPorcelain(record);
    expect([...parsed.changeTypesByPath]).toEqual([[path, changeType]]);
    expect(parsed.branch).toBeNull();
  });

  it.each(["DD", "AU", "UD", "UA", "DU", "AA", "UU"])(
    "retains the unmerged semantics of %s, including both-deleted conflicts",
    (code) => {
      const parsed = parseGitStatusPorcelain(
        `u ${code} N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} conflict.txt\0`,
      );
      expect(parsed.changeTypesByPath.get("conflict.txt")).toBe("unmerged");
    },
  );

  it("does not classify ignored entries or treat them as working-tree changes", () => {
    const parsed = parseGitStatusPorcelain("! ignored.bin\0");
    expect(parsed.hasWorkingTreeChanges).toBe(false);
    expect(parsed.changedFilesWithoutNumstat.size).toBe(0);
    expect(parsed.changeTypesByPath.size).toBe(0);
  });

  it("does not invent a change type for unknown or unchanged porcelain codes", () => {
    for (const code of ["Z.", ".."]) {
      const parsed = parseGitStatusPorcelain(
        `1 ${code} N... 100644 100644 100644 ${HASH} ${HASH} file.txt\0`,
      );
      expect(parsed.changeTypesByPath.size).toBe(0);
    }
  });

  it("propagates types to zero-count binary and empty-file summaries", () => {
    const types = new Map<string, GitFileChangeType>([
      ["added.bin", "added"],
      ["modified.bin", "modified"],
      ["deleted-empty.txt", "deleted"],
    ]);
    const summary = summarizeGitNumstatOutputs(
      [["-\t-\tadded.bin", "-\t-\tmodified.bin", "0\t0\tdeleted-empty.txt", ""].join("\0")],
      types,
    );
    expect(summary.insertions).toBe(0);
    expect(summary.deletions).toBe(0);
    for (const file of summary.files)
      expect(file).toEqual({
        path: file.path,
        insertions: 0,
        deletions: 0,
        changeType: types.get(file.path),
      });
    expect(summary.files).toHaveLength(3);
  });

  it("resolves aggregated untracked directories by complete path segments only", () => {
    const types = new Map<string, GitFileChangeType>([
      ["new dir/", "untracked"],
      ["new dir/conflict", "unmerged"],
    ]);
    expect(resolveGitStatusChangeType("new dir/nested/ empty.bin ", types)).toBe("untracked");
    expect(resolveGitStatusChangeType("new dir/conflict", types)).toBe("unmerged");
    expect(resolveGitStatusChangeType("new dir-other/file", types)).toBeUndefined();
    expect(resolveGitStatusChangeType("/unknown", types)).toBeUndefined();
  });

  it("carries normal staged rename/copy types without exposing their NUL source paths", () => {
    const types = new Map<string, GitFileChangeType>([
      ["new\tname\n.txt", "renamed"],
      ["copy.txt", "copied"],
    ]);
    const summary = summarizeGitNumstatOutputs(
      [["0\t0\t", "source", "new\tname\n.txt", "0\t0\t", "source", "copy.txt", ""].join("\0")],
      types,
    );
    expect(summary.files).toEqual([
      { path: "copy.txt", insertions: 0, deletions: 0, changeType: "copied" },
      { path: "new\tname\n.txt", insertions: 0, deletions: 0, changeType: "renamed" },
    ]);
  });

  it("preserves move-aware rename detection and unrelated untracked empty/binary files", () => {
    const types = new Map<string, GitFileChangeType>([
      ["old\tfile\n.txt", "deleted"],
      ["new dir/", "untracked"],
    ]);
    const output = [
      "0\t0\t",
      "old\tfile\n.txt",
      "new dir/moved.txt",
      "0\t0\tnew dir/empty.txt",
      "-\t-\tnew dir/binary.bin",
      "",
    ].join("\0");
    const summary = summarizeGitNumstatOutputs([output], types);
    expect(summary.files.find((file) => file.path === "new dir/moved.txt")?.changeType).toBe(
      "renamed",
    );
    expect(
      summary.files
        .filter((file) => file.path !== "new dir/moved.txt")
        .map((file) => file.changeType),
    ).toEqual(["untracked", "untracked"]);
    expect(summary.files.some((file) => file.path === "old\tfile\n.txt")).toBe(false);
    expect(summary).toMatchObject({ insertions: 0, deletions: 0 });
  });

  it.each(["copied", "unmerged", "deleted", "type-changed"] as const)(
    "does not overwrite authoritative %s with a detected move",
    (changeType) => {
      const types = new Map<string, GitFileChangeType>([
        ["source", "deleted"],
        ["destination", changeType],
      ]);
      expect(
        summarizeGitNumstatOutputs(["0\t0\t\0source\0destination\0"], types).files[0]?.changeType,
      ).toBe(changeType);
    },
  );

  it("retains a conflict even if temporary-index numstat has no record for it", () => {
    const types = new Map<string, GitFileChangeType>([["conflict.txt", "unmerged"]]);
    expect(summarizeGitNumstatOutputs([], types)).toEqual({
      files: [{ path: "conflict.txt", insertions: 0, deletions: 0, changeType: "unmerged" }],
      insertions: 0,
      deletions: 0,
    });
  });

  it("retains authoritative types when staged/worktree changes cancel in a temporary index", () => {
    const types = new Map<string, GitFileChangeType>([
      ["modified.txt", "modified"],
      ["type-change", "type-changed"],
      ["new-directory/", "untracked"],
    ]);
    expect(summarizeGitNumstatOutputs([], types, true)).toEqual({
      files: [
        { path: "modified.txt", insertions: 0, deletions: 0, changeType: "modified" },
        { path: "type-change", insertions: 0, deletions: 0, changeType: "type-changed" },
      ],
      insertions: 0,
      deletions: 0,
    });
  });
});
