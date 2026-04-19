import { describe, expect, it } from "vitest";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  getCanRetryAfterDownloadFailure,
  getAutoUpdateDisabledReason,
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
};

describe("shouldBroadcastDownloadProgress", () => {
  it("broadcasts the first downloading progress update", () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: "downloading", downloadPercent: null },
        1,
      ),
    ).toBe(true);
  });

  it("skips progress updates within the same 10% bucket", () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: "downloading", downloadPercent: 11.2 },
        18.7,
      ),
    ).toBe(false);
  });

  it("broadcasts progress updates when a new 10% bucket is reached", () => {
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
    ).toContain("T3CODE_DISABLE_AUTO_UPDATE");
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
