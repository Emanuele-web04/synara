import { describe, expect, it } from "vitest";
import type { DesktopUpdateState } from "@synara/contracts";

import {
  getCanRetryAfterDownloadFailure,
  getAutoUpdateDisabledReason,
  getDownloadStallTimeoutMessage,
  hasDownloadProgressAdvanced,
  isExpectedStalledDownloadCancellationError,
  isUpdateVersionNewer,
  nextStatusAfterDownloadFailure,
  shouldCheckForUpdatesOnForeground,
  shouldBroadcastDownloadProgress,
} from "./updateState";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  installFailureCount: 0,
  releaseUrl: null,
};

describe("getDownloadStallTimeoutMessage", () => {
  it("formats the no-progress timeout in seconds", () => {
    expect(getDownloadStallTimeoutMessage(90_000)).toBe(
      "Download stalled after 90 seconds without progress. Try again.",
    );
  });
});

describe("isExpectedStalledDownloadCancellationError", () => {
  it("suppresses the cancellation emitted after a stalled download is cancelled", () => {
    expect(
      isExpectedStalledDownloadCancellationError({
        suppressionArmed: true,
        errorContext: "download",
        message: " cancelled ",
      }),
    ).toBe(true);
  });

  it("does not suppress unrelated updater errors", () => {
    expect(
      isExpectedStalledDownloadCancellationError({
        suppressionArmed: false,
        errorContext: "download",
        message: "cancelled",
      }),
    ).toBe(false);
    expect(
      isExpectedStalledDownloadCancellationError({
        suppressionArmed: true,
        errorContext: "download",
        message: "network timeout",
      }),
    ).toBe(false);
    expect(
      isExpectedStalledDownloadCancellationError({
        suppressionArmed: true,
        errorContext: "check",
        message: "cancelled",
      }),
    ).toBe(false);
  });
});

describe("hasDownloadProgressAdvanced", () => {
  it("treats the first progress sample as active progress", () => {
    expect(hasDownloadProgressAdvanced(null, { percent: 10, transferred: 1_024 })).toBe(true);
  });

  it("ignores malformed progress samples without numeric progress", () => {
    expect(hasDownloadProgressAdvanced(null, {})).toBe(false);
  });

  it("detects byte progress inside the same percent bucket", () => {
    expect(
      hasDownloadProgressAdvanced(
        { percent: 40.1, transferred: 10_000 },
        { percent: 40.1, transferred: 12_000 },
      ),
    ).toBe(true);
  });

  it("does not treat duplicate progress samples as active progress", () => {
    expect(
      hasDownloadProgressAdvanced(
        { percent: 60, transferred: 20_000 },
        { percent: 60, transferred: 20_000 },
      ),
    ).toBe(false);
  });

  it("falls back to percent when transferred bytes are unavailable", () => {
    expect(hasDownloadProgressAdvanced({ percent: 60 }, { percent: 61 })).toBe(true);
    expect(hasDownloadProgressAdvanced({ percent: 60 }, { percent: 60 })).toBe(false);
  });

  it("resets on percent progress when transferred bytes do not advance", () => {
    expect(
      hasDownloadProgressAdvanced(
        { percent: 60, transferred: 20_000 },
        { percent: 61, transferred: 20_000 },
      ),
    ).toBe(true);
  });
});

describe("shouldBroadcastDownloadProgress", () => {
  it("broadcasts the first downloading progress update", () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: "downloading", downloadPercent: null },
        1,
      ),
    ).toBe(true);
  });

  it("skips progress updates within the same whole-percent bucket", () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: "downloading", downloadPercent: 11.2 },
        11.7,
      ),
    ).toBe(false);
  });

  it("broadcasts progress updates when a new whole-percent bucket is reached", () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: "downloading", downloadPercent: 19.9 },
        20.1,
      ),
    ).toBe(true);
  });

  it("broadcasts progress updates when a retry resets the download percentage", () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: "downloading", downloadPercent: 50.4 },
        0.2,
      ),
    ).toBe(true);
  });
});

describe("isUpdateVersionNewer", () => {
  it("rejects same-version updates from stale updater cache", () => {
    expect(isUpdateVersionNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isUpdateVersionNewer("0.1.0", "v0.1.0")).toBe(false);
  });

  it("allows newer stable versions and stable releases replacing matching prereleases", () => {
    expect(isUpdateVersionNewer("0.1.0", "0.1.1")).toBe(true);
    expect(isUpdateVersionNewer("0.1.0-beta.1", "0.1.0")).toBe(true);
  });

  it("rejects older versions", () => {
    expect(isUpdateVersionNewer("0.1.1", "0.1.0")).toBe(false);
    expect(isUpdateVersionNewer("1.0.0", "0.9.9")).toBe(false);
  });
});

describe("getAutoUpdateDisabledReason", () => {
  it("reports development builds as disabled", () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: true,
        isPackaged: false,
        platform: "darwin",
        appImage: undefined,
        disabledByEnv: false,
        hasUpdateFeedConfig: true,
      }),
    ).toContain("packaged production builds");
  });

  it("reports packaged builds without an update feed as disabled", () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: false,
        isPackaged: true,
        platform: "darwin",
        appImage: undefined,
        disabledByEnv: false,
        hasUpdateFeedConfig: false,
      }),
    ).toContain("no update feed");
  });

  it("allows packaged builds when an update feed is configured", () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: false,
        isPackaged: true,
        platform: "darwin",
        appImage: undefined,
        disabledByEnv: false,
        hasUpdateFeedConfig: true,
      }),
    ).toBeNull();
  });

  it("reports env-disabled auto updates", () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: false,
        isPackaged: true,
        platform: "darwin",
        appImage: undefined,
        disabledByEnv: true,
        hasUpdateFeedConfig: true,
      }),
    ).toContain("SYNARA_DISABLE_AUTO_UPDATE");
  });

  it("reports linux non-AppImage builds as disabled", () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: false,
        isPackaged: true,
        platform: "linux",
        appImage: undefined,
        disabledByEnv: false,
        hasUpdateFeedConfig: true,
      }),
    ).toContain("AppImage");
  });
});

describe("nextStatusAfterDownloadFailure", () => {
  it("returns available when an update version is still known", () => {
    expect(
      nextStatusAfterDownloadFailure({
        ...baseState,
        status: "downloading",
        availableVersion: "1.1.0",
      }),
    ).toBe("available");
  });

  it("returns error when no update version can be retried", () => {
    expect(
      nextStatusAfterDownloadFailure({
        ...baseState,
        status: "downloading",
        availableVersion: null,
      }),
    ).toBe("error");
  });
});

describe("getCanRetryAfterDownloadFailure", () => {
  it("returns true when an available version is still present", () => {
    expect(
      getCanRetryAfterDownloadFailure({
        ...baseState,
        status: "downloading",
        availableVersion: "1.1.0",
      }),
    ).toBe(true);
  });

  it("returns false when no version is available to retry", () => {
    expect(
      getCanRetryAfterDownloadFailure({
        ...baseState,
        status: "downloading",
        availableVersion: null,
      }),
    ).toBe(false);
  });
});

describe("shouldCheckForUpdatesOnForeground", () => {
  it("returns false when the app was not backgrounded first", () => {
    expect(
      shouldCheckForUpdatesOnForeground({
        checkedAt: "2026-03-04T00:00:00.000Z",
        backgroundedAtMs: null,
        foregroundedAtMs: Date.parse("2026-03-04T00:05:00.000Z"),
        minBackgroundDurationMs: 30_000,
        minIntervalMs: 5 * 60 * 1000,
      }),
    ).toBe(false);
  });

  it("returns true after foregrounding when no previous check exists", () => {
    expect(
      shouldCheckForUpdatesOnForeground({
        checkedAt: null,
        backgroundedAtMs: Date.parse("2026-03-04T00:00:00.000Z"),
        foregroundedAtMs: Date.parse("2026-03-04T00:05:00.000Z"),
        minBackgroundDurationMs: 30_000,
        minIntervalMs: 5 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it("returns false when the app was backgrounded too briefly", () => {
    expect(
      shouldCheckForUpdatesOnForeground({
        checkedAt: "2026-03-04T00:00:00.000Z",
        backgroundedAtMs: Date.parse("2026-03-04T00:04:45.000Z"),
        foregroundedAtMs: Date.parse("2026-03-04T00:05:00.000Z"),
        minBackgroundDurationMs: 30_000,
        minIntervalMs: 5 * 60 * 1000,
      }),
    ).toBe(false);
  });

  it("returns false when the last check is still within the foreground cooldown", () => {
    expect(
      shouldCheckForUpdatesOnForeground({
        checkedAt: "2026-03-04T00:03:00.000Z",
        backgroundedAtMs: Date.parse("2026-03-04T00:04:00.000Z"),
        foregroundedAtMs: Date.parse("2026-03-04T00:06:00.000Z"),
        minBackgroundDurationMs: 30_000,
        minIntervalMs: 5 * 60 * 1000,
      }),
    ).toBe(false);
  });

  it("returns true when the last check is older than the foreground cooldown", () => {
    expect(
      shouldCheckForUpdatesOnForeground({
        checkedAt: "2026-03-04T00:00:00.000Z",
        backgroundedAtMs: Date.parse("2026-03-04T00:04:00.000Z"),
        foregroundedAtMs: Date.parse("2026-03-04T00:06:00.000Z"),
        minBackgroundDurationMs: 30_000,
        minIntervalMs: 5 * 60 * 1000,
      }),
    ).toBe(true);
  });
});
