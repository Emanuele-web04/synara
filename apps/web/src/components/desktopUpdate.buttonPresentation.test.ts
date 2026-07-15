import { describe, expect, it } from "vitest";
import type { DesktopUpdateState } from "@synara/contracts";

import { getDesktopUpdateButtonPresentation } from "./desktopUpdate.logic";

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

describe("desktop update button presentation timeline", () => {
  it("surfaces checking, downloading and ready-to-install states without secondary detail text", () => {
    const checking = getDesktopUpdateButtonPresentation({
      ...baseState,
      status: "checking",
    });
    expect(checking).toEqual({
      label: "Checking...",
      secondaryLabel: null,
    });

    const downloading = getDesktopUpdateButtonPresentation({
      ...baseState,
      status: "downloading",
      availableVersion: "1.2.0",
      downloadPercent: 37.9,
    });
    expect(downloading).toEqual({
      label: "Preparing",
      secondaryLabel: null,
    });

    const downloaded = getDesktopUpdateButtonPresentation({
      ...baseState,
      status: "downloaded",
      availableVersion: "1.2.0",
      downloadedVersion: "1.2.0",
    });
    expect(downloaded).toEqual({
      label: "Update",
      secondaryLabel: null,
    });
  });

  it("shows a stable fallback when download progress is unavailable", () => {
    const downloading = getDesktopUpdateButtonPresentation({
      ...baseState,
      status: "downloading",
      availableVersion: "1.2.0",
      downloadPercent: null,
    });

    expect(downloading).toEqual({
      label: "Preparing",
      secondaryLabel: null,
    });
  });

  it("keeps downloading presentation stable for out-of-range progress values", () => {
    const over = getDesktopUpdateButtonPresentation({
      ...baseState,
      status: "downloading",
      availableVersion: "1.2.0",
      downloadPercent: 126.9,
    });
    expect(over).toEqual({
      label: "Preparing",
      secondaryLabel: null,
    });

    const below = getDesktopUpdateButtonPresentation({
      ...baseState,
      status: "downloading",
      availableVersion: "1.2.0",
      downloadPercent: -8,
    });
    expect(below).toEqual({
      label: "Preparing",
      secondaryLabel: null,
    });
  });

  it("shows Retry after an install failed across a restart", () => {
    expect(
      getDesktopUpdateButtonPresentation({
        ...baseState,
        status: "error",
        availableVersion: "1.2.0",
        downloadedVersion: null,
        errorContext: "install",
        canRetry: true,
        installFailureCount: 1,
      }),
    ).toEqual({
      label: "Retry",
      secondaryLabel: null,
    });
  });
});
