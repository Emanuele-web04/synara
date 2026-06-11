// FILE: updateFeedCache.ts
// Purpose: Caches desktop update-feed resolution between Electron updater checks.
// Layer: Desktop update utility
// Exports: CachedGitHubUpdateFeedRefresher

import type { LatestGitHubRelease } from "./githubUpdateFeed";

export interface CachedGitHubUpdateFeedRefresherOptions {
  readonly cacheTtlMs: number;
  readonly nowMs?: () => number;
  readonly resolveLatestRelease: () => Promise<LatestGitHubRelease | null>;
  readonly applyRelease: (release: LatestGitHubRelease) => void;
  readonly onStaleRefreshFailure?: (error: unknown, release: LatestGitHubRelease) => void;
}

export interface CachedGitHubUpdateFeedRefreshOptions {
  readonly force?: boolean;
}

type CachedRelease = {
  readonly release: LatestGitHubRelease;
  readonly refreshedAtMs: number;
};

export class CachedGitHubUpdateFeedRefresher {
  private cachedRelease: CachedRelease | null = null;
  private refreshInFlight: Promise<void> | null = null;

  constructor(private readonly options: CachedGitHubUpdateFeedRefresherOptions) {}

  getCachedRelease(): LatestGitHubRelease | null {
    return this.cachedRelease?.release ?? null;
  }

  async refresh(options: CachedGitHubUpdateFeedRefreshOptions = {}): Promise<void> {
    const force = options.force === true;
    if (!force && this.isCacheFresh()) {
      return;
    }

    if (this.refreshInFlight) {
      try {
        await this.refreshInFlight;
      } catch (error) {
        if (!force) {
          throw error;
        }
      }
      if (!force || this.isCacheFresh()) {
        return;
      }
    }

    this.refreshInFlight = this.refreshUncached({ allowStaleOnFailure: !force }).finally(() => {
      this.refreshInFlight = null;
    });
    return await this.refreshInFlight;
  }

  private isCacheFresh(): boolean {
    if (!this.cachedRelease) {
      return false;
    }
    return this.nowMs() - this.cachedRelease.refreshedAtMs < this.options.cacheTtlMs;
  }

  private nowMs(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  private async refreshUncached(options: { readonly allowStaleOnFailure: boolean }): Promise<void> {
    let release: LatestGitHubRelease | null;
    try {
      release = await this.options.resolveLatestRelease();
    } catch (error) {
      const cached = this.cachedRelease;
      if (cached && options.allowStaleOnFailure) {
        this.options.onStaleRefreshFailure?.(error, cached.release);
        return;
      }
      throw error;
    }

    if (release === null) {
      throw new Error("No stable GitHub release was found for the desktop update feed.");
    }

    this.options.applyRelease(release);
    this.cachedRelease = {
      release,
      refreshedAtMs: this.nowMs(),
    };
  }
}
