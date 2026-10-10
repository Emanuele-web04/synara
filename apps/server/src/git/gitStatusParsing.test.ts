import { describe, expect, it } from "vitest";

import {
  countTextFileLines,
  normalizeConfiguredMergeBranch,
  parseGitStatusPorcelain,
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
});
