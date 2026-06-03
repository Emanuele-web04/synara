// FILE: updateFeedCache.test.ts
// Purpose: Verifies desktop update-feed caching, in-flight dedupe, and stale fallback.
// Layer: Desktop update tests

import { describe, expect, it, vi } from "vitest";

import { CachedGitHubUpdateFeedRefresher } from "./updateFeedCache";
import type { LatestGitHubRelease } from "./githubUpdateFeed";

const release = (tag: string): LatestGitHubRelease => ({
  tag,
  version: tag.replace(/^v/, ""),
});

describe("CachedGitHubUpdateFeedRefresher", () => {
  it("skips resolving while the cached release is fresh", async () => {
    let nowMs = 1_000;
    const resolveLatestRelease = vi.fn(async () => release("v1.0.0"));
    const applyRelease = vi.fn();
    const refresher = new CachedGitHubUpdateFeedRefresher({
      cacheTtlMs: 60_000,
      nowMs: () => nowMs,
      resolveLatestRelease,
      applyRelease,
    });

    await refresher.refresh();
    nowMs += 1_000;
    await refresher.refresh();

    expect(resolveLatestRelease).toHaveBeenCalledTimes(1);
    expect(applyRelease).toHaveBeenCalledTimes(1);
    expect(refresher.getCachedRelease()).toEqual(release("v1.0.0"));
  });

  it("force refreshes even while the cached release is fresh", async () => {
    let nowMs = 1_000;
    const resolveLatestRelease = vi
      .fn()
      .mockResolvedValueOnce(release("v1.0.0"))
      .mockResolvedValueOnce(release("v1.1.0"));
    const applyRelease = vi.fn();
    const refresher = new CachedGitHubUpdateFeedRefresher({
      cacheTtlMs: 60_000,
      nowMs: () => nowMs,
      resolveLatestRelease,
      applyRelease,
    });

    await refresher.refresh();
    nowMs += 1_000;
    await refresher.refresh({ force: true });

    expect(resolveLatestRelease).toHaveBeenCalledTimes(2);
    expect(applyRelease).toHaveBeenCalledTimes(2);
    expect(refresher.getCachedRelease()).toEqual(release("v1.1.0"));
  });

  it("deduplicates concurrent refreshes", async () => {
    let resolveRelease!: (release: LatestGitHubRelease) => void;
    const resolveLatestRelease = vi.fn(
      () =>
        new Promise<LatestGitHubRelease>((resolve) => {
          resolveRelease = resolve;
        }),
    );
    const applyRelease = vi.fn();
    const refresher = new CachedGitHubUpdateFeedRefresher({
      cacheTtlMs: 60_000,
      resolveLatestRelease,
      applyRelease,
    });

    const first = refresher.refresh();
    const second = refresher.refresh();
    resolveRelease(release("v1.1.0"));
    await Promise.all([first, second]);

    expect(resolveLatestRelease).toHaveBeenCalledTimes(1);
    expect(applyRelease).toHaveBeenCalledTimes(1);
  });

  it("keeps using the stale release after a refresh failure", async () => {
    let nowMs = 1_000;
    const resolveLatestRelease = vi
      .fn()
      .mockResolvedValueOnce(release("v1.0.0"))
      .mockRejectedValueOnce(new Error("GitHub unavailable"));
    const applyRelease = vi.fn();
    const onStaleRefreshFailure = vi.fn();
    const refresher = new CachedGitHubUpdateFeedRefresher({
      cacheTtlMs: 60_000,
      nowMs: () => nowMs,
      resolveLatestRelease,
      applyRelease,
      onStaleRefreshFailure,
    });

    await refresher.refresh();
    nowMs += 60_001;
    await expect(refresher.refresh()).resolves.toBeUndefined();

    expect(resolveLatestRelease).toHaveBeenCalledTimes(2);
    expect(applyRelease).toHaveBeenCalledTimes(1);
    expect(onStaleRefreshFailure).toHaveBeenCalledWith(expect.any(Error), release("v1.0.0"));
  });

  it("surfaces forced refresh failures instead of falling back to stale cache", async () => {
    let nowMs = 1_000;
    const resolveLatestRelease = vi
      .fn()
      .mockResolvedValueOnce(release("v1.0.0"))
      .mockRejectedValueOnce(new Error("GitHub unavailable"));
    const applyRelease = vi.fn();
    const onStaleRefreshFailure = vi.fn();
    const refresher = new CachedGitHubUpdateFeedRefresher({
      cacheTtlMs: 60_000,
      nowMs: () => nowMs,
      resolveLatestRelease,
      applyRelease,
      onStaleRefreshFailure,
    });

    await refresher.refresh();
    nowMs += 1_000;
    await expect(refresher.refresh({ force: true })).rejects.toThrow("GitHub unavailable");

    expect(resolveLatestRelease).toHaveBeenCalledTimes(2);
    expect(applyRelease).toHaveBeenCalledTimes(1);
    expect(onStaleRefreshFailure).not.toHaveBeenCalled();
    expect(refresher.getCachedRelease()).toEqual(release("v1.0.0"));
  });

  it("retries a forced refresh when an in-flight automatic refresh falls back to stale cache", async () => {
    let nowMs = 1_000;
    let rejectStaleRefresh!: (error: Error) => void;
    const resolveLatestRelease = vi
      .fn()
      .mockResolvedValueOnce(release("v1.0.0"))
      .mockImplementationOnce(
        () =>
          new Promise<LatestGitHubRelease>((_resolve, reject) => {
            rejectStaleRefresh = reject;
          }),
      )
      .mockResolvedValueOnce(release("v1.2.0"));
    const applyRelease = vi.fn();
    const onStaleRefreshFailure = vi.fn();
    const refresher = new CachedGitHubUpdateFeedRefresher({
      cacheTtlMs: 60_000,
      nowMs: () => nowMs,
      resolveLatestRelease,
      applyRelease,
      onStaleRefreshFailure,
    });

    await refresher.refresh();
    nowMs += 60_001;
    const automaticRefresh = refresher.refresh();
    const forcedRefresh = refresher.refresh({ force: true });
    rejectStaleRefresh(new Error("GitHub unavailable"));
    await Promise.all([automaticRefresh, forcedRefresh]);

    expect(resolveLatestRelease).toHaveBeenCalledTimes(3);
    expect(applyRelease).toHaveBeenCalledTimes(2);
    expect(onStaleRefreshFailure).toHaveBeenCalledTimes(1);
    expect(refresher.getCachedRelease()).toEqual(release("v1.2.0"));
  });

  it("retries a forced refresh when an in-flight cold automatic refresh fails", async () => {
    let rejectAutomaticRefresh!: (error: Error) => void;
    const resolveLatestRelease = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<LatestGitHubRelease>((_resolve, reject) => {
            rejectAutomaticRefresh = reject;
          }),
      )
      .mockResolvedValueOnce(release("v1.1.0"));
    const applyRelease = vi.fn();
    const refresher = new CachedGitHubUpdateFeedRefresher({
      cacheTtlMs: 60_000,
      resolveLatestRelease,
      applyRelease,
    });

    const automaticRefresh = refresher.refresh();
    const automaticExpectation = expect(automaticRefresh).rejects.toThrow("startup timeout");
    const forcedRefresh = refresher.refresh({ force: true });
    rejectAutomaticRefresh(new Error("startup timeout"));

    await automaticExpectation;
    await expect(forcedRefresh).resolves.toBeUndefined();

    expect(resolveLatestRelease).toHaveBeenCalledTimes(2);
    expect(applyRelease).toHaveBeenCalledTimes(1);
    expect(refresher.getCachedRelease()).toEqual(release("v1.1.0"));
  });
});
