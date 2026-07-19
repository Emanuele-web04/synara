import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./PullRequestDetailPanel.tsx", import.meta.url), "utf8");

describe("pull request detail product policy", () => {
  it("keeps merge on GitHub instead of exposing a native merge action", () => {
    expect(source).toContain("Open on GitHub");
    expect(source).not.toContain('runAction("merge"');
    expect(source).not.toContain('setConfirmAction("merge"');
    expect(source).not.toContain("PullRequestMergeMethod");
  });

  it("routes pull requests through durable workspace actions", () => {
    expect(source).toContain("Review in new workspace");
    expect(source).toContain("Open workspace");
    expect(source).toContain("Restore workspace");
    expect(source).toContain("New review conversation");
    expect(source).toContain("openPullRequestWorkspace");
    expect(source).not.toContain("preparePullRequestThread");
    expect(source).not.toContain("gitPreparePullRequestThreadMutationOptions");
  });
});
