import { describe, expect, it } from "vitest";

import {
  checkpointReflogAnchor,
  chunkArgumentGroups,
  formatCheckpointHeadTrailer,
  parseCheckpointCommit,
  parseRawDiff,
} from "./historyIntegration.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

describe("parseCheckpointCommit", () => {
  it("reads the recorded HEAD and reflog anchor", () => {
    const entry = `${HEAD}\tHEAD@{1731456001 -0500}\tcommit: sample`;
    const raw = [
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "author Synara <synara@users.noreply.github.com> 1731456000 +0100",
      "committer Synara <synara@users.noreply.github.com> 1731456001 -0500",
      "",
      "Synara checkpoint ref=refs/synara/checkpoints/a/turn/1",
      "",
      formatCheckpointHeadTrailer(HEAD, entry),
      "",
    ].join("\n");

    expect(parseCheckpointCommit(raw)).toEqual({
      head: HEAD,
      reflogAnchor: checkpointReflogAnchor(entry),
    });
  });

  it("treats checkpoints without a valid recorded HEAD as legacy", () => {
    const header = "committer Synara <s@example.com> 1731456001 +0000\n\n";
    expect(parseCheckpointCommit(`${header}Synara checkpoint ref=x\n`).head).toBeNull();
    expect(parseCheckpointCommit(`${header}Synara-Head: not-an-oid\n`).head).toBeNull();
    // A trailer-shaped line in the header is not a recorded HEAD.
    expect(parseCheckpointCommit(`Synara-Head: ${HEAD}\n`).head).toBeNull();
  });
});

describe("parseRawDiff", () => {
  it("parses NUL-delimited raw entries, including paths with spaces", () => {
    const zero = "0".repeat(40);
    const stdout = [
      `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M`,
      "src/my file.ts",
      `:000000 100644 ${zero} ${"c".repeat(40)} A`,
      ".github/CI.md",
      "",
    ].join("\0");

    expect(parseRawDiff(stdout)).toEqual([
      {
        path: "src/my file.ts",
        sourceMode: "100644",
        sourceObject: "a".repeat(40),
        status: "M",
      },
      { path: ".github/CI.md", sourceMode: "000000", sourceObject: zero, status: "A" },
    ]);
  });
});

describe("chunkArgumentGroups", () => {
  it("keeps groups intact and every chunk under the limit", () => {
    const groups = Array.from({ length: 50 }, (_, index) => [
      "--cacheinfo",
      "100644",
      "x",
      `p${index}`,
    ]);
    const chunks = chunkArgumentGroups(groups, 200);

    expect(chunks.flat()).toEqual(groups.flat());
    for (const chunk of chunks) {
      expect(chunk.length % 4).toBe(0);
      expect(chunk.reduce((total, arg) => total + arg.length + 3, 0)).toBeLessThanOrEqual(200);
    }
  });
});
