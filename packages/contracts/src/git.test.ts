import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { GitReadWorkingTreeDiffInput } from "./git";

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
