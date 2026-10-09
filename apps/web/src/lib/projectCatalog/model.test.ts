import { describe, expect, it } from "vitest";
import {
  catalogSuggestions,
  checkoutKey,
  emptyCatalog,
  excludeSuggestion,
  linkCheckouts,
  observeCheckouts,
  repositoryIdentity,
  splitGroup,
  type CatalogCheckout,
} from "./model";

const checkout = (environmentId: string, projectId: string, url: string): CatalogCheckout => ({
  environmentId,
  projectId,
  name: "Synara",
  cwd: `/code/${projectId}`,
  hostName: environmentId,
  channel: "beta",
  observedAt: "2026-09-27T00:00:00Z",
  repositoryUrls: url ? [url] : [],
});

describe("project catalog", () => {
  it("suggests equivalent GitHub transports, preserving forks, ambiguous remotes and self-hosted case/ports", () => {
    expect(repositoryIdentity("git@github.com:Owner/Repo.git")).toBe("github.com/owner/repo");
    expect(repositoryIdentity("https://github.com/owner/repo")).toBe("github.com/owner/repo");
    expect(repositoryIdentity("ssh://git@git.example:2222/Owner/Repo.git")).not.toBe(
      repositoryIdentity("https://git.example/owner/repo.git"),
    );
    expect(repositoryIdentity("https://git.example/Owner/Repo")).not.toBe(
      repositoryIdentity("https://git.example/owner/repo"),
    );
    const a = checkout("mini", "same-id", "git@github.com:Owner/Repo.git");
    const b = checkout("book", "same-id", "https://github.com/owner/repo");
    const fork = checkout("book", "fork", "https://github.com/fork-owner/repo");
    const multiple = {
      ...checkout("mini", "multiple", "https://github.com/owner/repo"),
      repositoryUrls: ["https://github.com/owner/repo", "https://github.com/fork-owner/repo"],
    };
    expect(
      catalogSuggestions({
        ...emptyCatalog(),
        checkouts: [a, b, fork, multiple, checkout("mini", "no-origin", "")],
      }).map(([left, right]) => [left.environmentId, right.environmentId]),
    ).toEqual([["mini", "book"]]);
    expect(checkoutKey(a)).not.toBe(checkoutKey(b));
  });

  it("keeps two clones as members and retains explicit exclusions and split corrections through serialization", () => {
    const a = checkout("mini", "clone-a", "https://github.com/o/r");
    const b = checkout("mini", "clone-b", "https://github.com/o/r");
    const c = checkout("book", "clone-a", "https://github.com/o/r");
    let catalog = { ...emptyCatalog(), checkouts: [a, b, c] };
    catalog = excludeSuggestion(catalog, a, c);
    catalog = linkCheckouts(catalog, [a, b], "Work", "group");
    catalog.groups[0]!.preferredCheckout = a;
    catalog = JSON.parse(JSON.stringify(splitGroup(catalog, "group")));
    expect(catalog.checkouts).toEqual([a, b, c]);
    expect(catalog.groups).toEqual([]);
    expect(
      catalogSuggestions(catalog).map(([left, right]) => [left.projectId, right.environmentId]),
    ).toEqual([["clone-b", "book"]]);
  });

  it("refreshes only the observed environment, preserving offline paths and group membership", () => {
    const a = checkout("mini", "same-id", "https://github.com/o/r");
    const b = checkout("book", "same-id", "https://github.com/o/r");
    const catalog = linkCheckouts({ ...emptyCatalog(), checkouts: [a, b] }, [a, b], "Work", "g");
    const refreshed = observeCheckouts(catalog, "book", []);
    expect(refreshed.checkouts[0]).toEqual(a);
    expect(refreshed.checkouts[1]?.missing).toBe(true);
    expect(refreshed.groups[0]?.members).toHaveLength(2);
    const moved = observeCheckouts(refreshed, "book", [
      { ...b, cwd: "/different/repository", repositoryUrls: [] },
    ]);
    expect(moved.checkouts[1]?.repositoryUrls).toEqual([]);
    expect(moved.checkouts[1]?.missing).toBeUndefined();
  });
});

it("does not collapse ambiguous raw paths or self-hosted repository suffixes", () => {
  expect(repositoryIdentity("https://github.com/a/../b/repo")).toBeNull();
  expect(repositoryIdentity("https://github.com/a/%2e/repo")).toBeNull();
  expect(repositoryIdentity("https://git.example/a/repo.git")).not.toBe(
    repositoryIdentity("https://git.example/a/repo"),
  );
});
