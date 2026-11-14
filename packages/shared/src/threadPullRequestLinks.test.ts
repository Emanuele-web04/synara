import type {
  OrchestrationThreadPullRequest,
  OrchestrationThreadPullRequestLink,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  THREAD_PULL_REQUEST_LINK_LIMIT,
  linkPullRequest,
  pullRequestLinkKey,
  pullRequestLinksFromEventPayload,
  refreshPullRequestSnapshots,
  resolveBranchManagedPullRequest,
  resolveCurrentPullRequest,
  syncDiscoveredPullRequest,
  unlinkPullRequest,
  visiblePullRequestLinks,
} from "./threadPullRequestLinks";

const pr = (
  number: number,
  overrides: Partial<OrchestrationThreadPullRequest> = {},
): OrchestrationThreadPullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  baseBranch: "main",
  headBranch: `feat/${number}`,
  state: "open",
  ...overrides,
});

const at = (minute: number) => `2026-11-13T10:${String(minute).padStart(2, "0")}:00.000Z`;

describe("pullRequestLinkKey", () => {
  it("identifies a PR across URL casing and suffixes", () => {
    expect(pullRequestLinkKey("https://github.com/Acme/App/pull/7/files")).toBe(
      pullRequestLinkKey("https://github.com/acme/app/pull/7"),
    );
    expect(pullRequestLinkKey("https://github.com/acme/app/pull/7")).not.toBe(
      pullRequestLinkKey("https://github.com/acme/other/pull/7"),
    );
  });
});

describe("linkPullRequest", () => {
  it("adds links instead of replacing the thread's PR", () => {
    const links = linkPullRequest(
      linkPullRequest([], { pullRequest: pr(1), source: "agent", linkedAt: at(0) }),
      { pullRequest: pr(2), source: "created", linkedAt: at(1) },
    );
    expect(links.map((link) => [link.pullRequest.number, link.source])).toEqual([
      [1, "agent"],
      [2, "created"],
    ]);
  });

  it("refreshes an existing link without duplicating it or changing its provenance", () => {
    const first = linkPullRequest([], { pullRequest: pr(1), source: "agent", linkedAt: at(0) });
    const again = linkPullRequest(first, {
      pullRequest: pr(1, { title: "Renamed", url: "https://github.com/ACME/app/pull/1" }),
      source: "user",
      linkedAt: at(5),
    });
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ source: "agent", linkedAt: at(0) });
    expect(again[0]?.pullRequest.title).toBe("Renamed");
  });

  it("upgrades a branch-discovered link to explicit and revives a tombstone", () => {
    const discovered = syncDiscoveredPullRequest([], pr(1), at(0));
    expect(
      linkPullRequest(discovered, { pullRequest: pr(1), source: "agent", linkedAt: at(3) })[0],
    ).toMatchObject({ source: "agent", linkedAt: at(0) });

    const tombstoned = unlinkPullRequest(discovered, pr(1).url, at(2))!;
    const revived = linkPullRequest(tombstoned, {
      pullRequest: pr(1),
      source: "user",
      linkedAt: at(4),
    });
    expect(revived[0]).toEqual({ pullRequest: pr(1), source: "user", linkedAt: at(4) });
  });

  it("caps the list by dropping tombstones and settled links first", () => {
    let links: OrchestrationThreadPullRequestLink[] = [];
    for (let index = 1; index <= THREAD_PULL_REQUEST_LINK_LIMIT; index += 1) {
      links = linkPullRequest(links, {
        pullRequest: pr(index, { state: index === 2 ? "merged" : "open" }),
        source: "agent",
        linkedAt: at(index % 60),
      });
    }
    links = unlinkPullRequest(links, pr(1).url, at(59))!;
    links = linkPullRequest(links, { pullRequest: pr(999), source: "agent", linkedAt: at(59) });
    links = linkPullRequest(links, { pullRequest: pr(1000), source: "agent", linkedAt: at(59) });
    expect(links).toHaveLength(THREAD_PULL_REQUEST_LINK_LIMIT);
    const numbers = links.map((link) => link.pullRequest.number);
    expect(numbers).not.toContain(1);
    expect(numbers).not.toContain(2);
    expect(numbers).toContain(1000);
  });
});

describe("unlinkPullRequest", () => {
  it("keeps a tombstone and reports a missing link as no change", () => {
    const links = linkPullRequest([], { pullRequest: pr(1), source: "agent", linkedAt: at(0) });
    const unlinked = unlinkPullRequest(links, pr(1).url, at(1));
    expect(unlinked?.[0]?.dismissedAt).toBe(at(1));
    expect(visiblePullRequestLinks(unlinked)).toEqual([]);
    expect(resolveCurrentPullRequest(unlinked)).toBeNull();
    expect(unlinkPullRequest(unlinked, pr(1).url, at(2))).toBeNull();
    expect(unlinkPullRequest(links, pr(9).url, at(2))).toBeNull();
  });
});

describe("syncDiscoveredPullRequest", () => {
  it("replaces only branch-managed links and never touches explicit ones", () => {
    const explicit = linkPullRequest([], { pullRequest: pr(1), source: "agent", linkedAt: at(0) });
    const withDiscovered = syncDiscoveredPullRequest(explicit, pr(2), at(1));
    expect(withDiscovered.map((link) => link.source)).toEqual(["agent", "discovered"]);

    const moved = syncDiscoveredPullRequest(withDiscovered, pr(3), at(2));
    expect(moved.map((link) => link.pullRequest.number)).toEqual([1, 3]);

    const cleared = syncDiscoveredPullRequest(moved, null, at(3));
    expect(cleared.map((link) => link.pullRequest.number)).toEqual([1]);
    expect(resolveCurrentPullRequest(cleared)?.number).toBe(1);
  });

  it("treats the legacy slot like a discovered link", () => {
    const legacy = pullRequestLinksFromEventPayload({ lastKnownPr: pr(1) }, at(0))!;
    expect(legacy[0]?.source).toBe("legacy");
    expect(resolveBranchManagedPullRequest(legacy)?.number).toBe(1);
    expect(syncDiscoveredPullRequest(legacy, null, at(1))).toEqual([]);
  });

  it("does not resurrect a PR the user unlinked", () => {
    const discovered = syncDiscoveredPullRequest([], pr(1), at(0));
    const tombstoned = unlinkPullRequest(discovered, pr(1).url, at(1))!;
    expect(syncDiscoveredPullRequest(tombstoned, pr(1), at(2))).toEqual(tombstoned);
  });
});

describe("resolveCurrentPullRequest", () => {
  it("prefers an open link, then the most recently linked", () => {
    const merged = linkPullRequest([], {
      pullRequest: pr(1, { state: "merged" }),
      source: "agent",
      linkedAt: at(5),
    });
    const withOpen = linkPullRequest(merged, {
      pullRequest: pr(2),
      source: "agent",
      linkedAt: at(1),
    });
    expect(resolveCurrentPullRequest(withOpen)?.number).toBe(2);

    const stackTop = linkPullRequest(withOpen, {
      pullRequest: pr(3),
      source: "agent",
      linkedAt: at(2),
    });
    expect(resolveCurrentPullRequest(stackTop)?.number).toBe(3);
    expect(resolveCurrentPullRequest([])).toBeNull();
  });
});

describe("refreshPullRequestSnapshots", () => {
  it("updates linked PRs only and never adds new links", () => {
    const links = linkPullRequest([], { pullRequest: pr(1), source: "agent", linkedAt: at(0) });
    const refreshed = refreshPullRequestSnapshots(links, [pr(1, { state: "merged" }), pr(2)]);
    expect(refreshed.map((link) => [link.pullRequest.number, link.pullRequest.state])).toEqual([
      [1, "merged"],
    ]);
  });
});

describe("pullRequestLinksFromEventPayload", () => {
  it("prefers the link list and leaves untouched payloads alone", () => {
    const links = linkPullRequest([], { pullRequest: pr(1), source: "agent", linkedAt: at(0) });
    expect(
      pullRequestLinksFromEventPayload({ pullRequests: links, lastKnownPr: pr(1) }, at(1)),
    ).toEqual(links);
    expect(pullRequestLinksFromEventPayload({ lastKnownPr: null }, at(1))).toEqual([]);
    expect(pullRequestLinksFromEventPayload({}, at(1))).toBeUndefined();
  });
});
