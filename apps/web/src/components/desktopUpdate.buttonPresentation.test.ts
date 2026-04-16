import { describe, expect, it } from "vitest";
import type { DesktopUpdateState } from "@t3tools/contracts";

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
};

describe("desktop update button presentation timeline", () => {
  it("surfaces checking, downloading and ready-to-install states without secondary detail text", () => {
    const checking = getDesktopUpdateButtonPresentation({
      ...baseState,
      status: "checking",
    });
    expect(checking.label).toBe("Checking...");
    expect(checking.progressPercent).toBeNull();

    const downloading = getDesktopUpdateButtonPresentation({
      ...baseState,
      status: "downloading",
      availableVersion: "1.2.0",
      downloadPercent: 37.9,
    });
    expect(downloading.label).toBe("Downloading...");
    expect(downloading.progressPercent).toBe(37);

    const downloaded = getDesktopUpdateButtonPresentation({
      ...baseState,
      status: "downloaded",
      availableVersion: "1.2.0",
      downloadedVersion: "1.2.0",
    });
    expect(downloaded.label).toBe("Ready to update");
    expect(downloaded.progressPercent).toBeNull();
  });

  it("shows a stable fallback when download progress is unavailable", () => {
    const downloading = getDesktopUpdateButtonPresentation({
      ...baseState,
      status: "downloading",
      availableVersion: "1.2.0",
      downloadPercent: null,
    });

    expect(downloading.label).toBe("Downloading...");
    expect(downloading.progressPercent).toBeNull();
  });

  it("clamps percentage output to avoid invalid UI values", () => {
    const over = getDesktopUpdateButtonPresentation({
      ...baseState,
      status: "downloading",
      availableVersion: "1.2.0",
      downloadPercent: 126.9,
    });
    expect(over.progressPercent).toBe(100);

    const below = getDesktopUpdateButtonPresentation({
      ...baseState,
      status: "downloading",
      availableVersion: "1.2.0",
      downloadPercent: -8,
    });
    expect(below.progressPercent).toBe(0);
  });
});
