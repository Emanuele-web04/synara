import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sidebarSource = readFileSync(new URL("../Sidebar.tsx", import.meta.url), "utf8");
const browserRouteSource = readFileSync(
  new URL("../../routes/_chat.pull-requests.index.tsx", import.meta.url),
  "utf8",
);

describe("pull request workspace action policy", () => {
  it("routes row workspace actions through the canonical coordinator without direct Git mutation", () => {
    expect(browserRouteSource).toContain("openPullRequestWorkspace");
    expect(browserRouteSource).toContain("requestWorkspaceArchive");
    expect(browserRouteSource).toContain("appendComposerPromptText");
    expect(browserRouteSource).not.toContain("preparePullRequestThread");
  });

  it("drafts workspace remedy prompts in new conversations and derives comment availability", () => {
    expect(sidebarSource).toContain('case "fix-review-comments"');
    expect(sidebarSource).toContain('intent: "new-conversation"');
    expect(sidebarSource).toContain("buildFixFindingsPrompt");
    expect(sidebarSource).toContain("buildResolveConflictsPrompt");
    expect(sidebarSource).toContain("appendComposerPromptText");
    expect(sidebarSource).toContain("workspacePullRequestDetailById");
    expect(sidebarSource).not.toContain("hasReviewComments: false");
  });
});
