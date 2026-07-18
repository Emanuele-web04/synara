import { describe, expect, it } from "vitest";

import {
  normalizePullRequestInvolvement,
  normalizePullRequestState,
  PULL_REQUEST_INVOLVEMENT_TABS,
  PULL_REQUEST_PICKER_FILTERS,
  pullRequestPickerScope,
} from "./pullRequestBrowser.logic";

describe("pull request browser defaults", () => {
  it("opens on active review requests", () => {
    expect(normalizePullRequestInvolvement(undefined)).toBe("reviewing");
    expect(normalizePullRequestState(undefined)).toBe("open");
  });

  it("keeps explicit involvement and completed-state filters", () => {
    expect(normalizePullRequestInvolvement("all")).toBe("all");
    expect(normalizePullRequestInvolvement("authored")).toBe("authored");
    expect(normalizePullRequestState("closed")).toBe("closed");
    expect(normalizePullRequestState("merged")).toBe("merged");
  });

  it("uses newcomer-readable involvement labels", () => {
    expect(PULL_REQUEST_INVOLVEMENT_TABS).toEqual([
      { value: "all", label: "All" },
      { value: "reviewing", label: "Review requested" },
      { value: "authored", label: "My PRs" },
    ]);
  });

  it("keeps the workspace picker active by default and separates completed states", () => {
    expect(PULL_REQUEST_PICKER_FILTERS[0]).toEqual({
      value: "reviewing",
      label: "Review requested",
    });
    expect(pullRequestPickerScope("reviewing")).toEqual({
      involvement: "reviewing",
      state: "open",
    });
    expect(pullRequestPickerScope("authored")).toEqual({
      involvement: "authored",
      state: "open",
    });
    expect(pullRequestPickerScope("merged")).toEqual({
      involvement: "all",
      state: "merged",
    });
  });
});
