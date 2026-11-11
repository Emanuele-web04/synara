import { describe, expect, it } from "vitest";

import {
  mapReleaseAssets,
  parseReleaseDownloadsSnapshot,
  RELEASE_ASSET_PATTERNS,
} from "./releaseDownloads.ts";

const releaseUrl = "https://github.com/o/r/releases/tag/v1.5.1";
const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/o/r/releases/download/v1.5.1/${name}`,
});

describe("release download assets", () => {
  it("maps both Linux architectures and every other installer by name", () => {
    const downloads = mapReleaseAssets(
      {
        tag_name: "v1.5.1",
        html_url: releaseUrl,
        assets: [
          asset("Synara-1.5.1-arm64.dmg"),
          asset("Synara-1.5.1-x64.dmg"),
          asset("Synara-1.5.1-x64.exe"),
          asset("Synara-1.5.1-x86_64.AppImage"),
          asset("Synara-1.5.1-arm64.AppImage"),
          asset("latest-linux.yml"),
          asset("artifact-linux-arm64.provenance.json"),
        ],
      },
      releaseUrl,
    );

    expect(downloads.version).toBe("v1.5.1");
    expect(downloads.releasesUrl).toBe(releaseUrl);
    expect(downloads.mac).toEqual({
      arm64: asset("Synara-1.5.1-arm64.dmg").browser_download_url,
      x64: asset("Synara-1.5.1-x64.dmg").browser_download_url,
    });
    expect(downloads.windows).toBe(asset("Synara-1.5.1-x64.exe").browser_download_url);
    expect(downloads.linux).toEqual({
      x64: asset("Synara-1.5.1-x86_64.AppImage").browser_download_url,
      arm64: asset("Synara-1.5.1-arm64.AppImage").browser_download_url,
    });
  });

  it("ignores download URLs that are not HTTPS", () => {
    const downloads = mapReleaseAssets(
      {
        tag_name: "v1.5.1",
        html_url: releaseUrl,
        assets: [
          { name: "Synara-1.5.1-arm64.AppImage", browser_download_url: "javascript:alert(1)" },
        ],
      },
      releaseUrl,
    );
    expect(downloads.linux.arm64).toBe(releaseUrl);
  });

  it("keeps the architectures apart when a release ships only one of them", () => {
    const intelOnly = mapReleaseAssets(
      { tag_name: "v1.5.1", assets: [asset("Synara-1.5.1-x86_64.AppImage")] },
      releaseUrl,
    );
    expect(intelOnly.linux.x64).toContain("x86_64.AppImage");
    expect(intelOnly.linux.arm64).toBe(releaseUrl);

    const armOnly = mapReleaseAssets(
      { tag_name: "v1.5.1", assets: [asset("Synara-1.5.1-arm64.AppImage")] },
      releaseUrl,
    );
    expect(armOnly.linux.arm64).toContain("arm64.AppImage");
    expect(armOnly.linux.x64).toBe(releaseUrl);
  });

  it("falls back to the release page when an installer is missing", () => {
    const downloads = mapReleaseAssets({ assets: [] }, releaseUrl);
    expect(downloads.version).toBeNull();
    expect(downloads.releasesUrl).toBe(releaseUrl);
    expect(Object.values(downloads.mac)).toEqual([releaseUrl, releaseUrl]);
    expect(downloads.windows).toBe(releaseUrl);
    expect(downloads.linux).toEqual({ x64: releaseUrl, arm64: releaseUrl });
  });

  it("prefers the release's own page over the caller fallback", () => {
    const listingUrl = "https://github.com/o/r/releases";
    const downloads = mapReleaseAssets(
      { tag_name: "v1.5.1", html_url: releaseUrl, assets: [] },
      listingUrl,
    );
    expect(downloads.releasesUrl).toBe(releaseUrl);
    expect(downloads.linux).toEqual({ x64: releaseUrl, arm64: releaseUrl });
  });

  it("narrows a valid stored snapshot and keeps snapshot-only fields out", () => {
    const snapshot = {
      version: "v1.5.1",
      releasesUrl: releaseUrl,
      mac: { arm64: "https://example.test/mac-arm64.dmg", x64: "https://example.test/mac-x64.dmg" },
      windows: "https://example.test/win.exe",
      linux: {
        x64: "https://example.test/linux-x86_64.AppImage",
        arm64: "https://example.test/linux-arm64.AppImage",
      },
      updatedAt: "2026-11-11T00:00:00.000Z",
      source: "https://api.github.com/repos/o/r/releases/latest",
    };
    expect(parseReleaseDownloadsSnapshot(snapshot)).toEqual({
      version: "v1.5.1",
      releasesUrl: releaseUrl,
      mac: { arm64: "https://example.test/mac-arm64.dmg", x64: "https://example.test/mac-x64.dmg" },
      windows: "https://example.test/win.exe",
      linux: {
        x64: "https://example.test/linux-x86_64.AppImage",
        arm64: "https://example.test/linux-arm64.AppImage",
      },
    });
  });

  it("rejects snapshots whose URLs are not HTTPS", () => {
    const valid = {
      version: "v1.5.1",
      releasesUrl: releaseUrl,
      mac: { arm64: `${releaseUrl}/a.dmg`, x64: `${releaseUrl}/b.dmg` },
      windows: `${releaseUrl}/c.exe`,
      linux: { x64: `${releaseUrl}/d.AppImage`, arm64: `${releaseUrl}/e.AppImage` },
    };
    expect(parseReleaseDownloadsSnapshot(valid)).not.toBeNull();
    expect(
      parseReleaseDownloadsSnapshot({
        ...valid,
        linux: { ...valid.linux, arm64: "javascript:alert(1)" },
      }),
    ).toBeNull();
  });

  it("rejects the pre-arm64 snapshot shape instead of rendering it", () => {
    const legacy = {
      version: "v1.1.0",
      releasesUrl: releaseUrl,
      mac: { arm64: "https://example.test/mac-arm64.dmg", x64: "https://example.test/mac-x64.dmg" },
      windows: "https://example.test/win.exe",
      linux: "https://example.test/linux-x86_64.AppImage",
    };
    expect(parseReleaseDownloadsSnapshot(legacy)).toBeNull();
    expect(
      parseReleaseDownloadsSnapshot({
        ...legacy,
        linux: { x64: "https://example.test/linux-x86_64.AppImage" },
      }),
    ).toBeNull();
    expect(
      parseReleaseDownloadsSnapshot({
        ...legacy,
        linux: { x64: "", arm64: "https://example.test/linux-arm64.AppImage" },
      }),
    ).toBeNull();
    expect(parseReleaseDownloadsSnapshot(null)).toBeNull();

    const valid = {
      version: "v1.5.1",
      releasesUrl: releaseUrl,
      mac: { arm64: "https://example.test/mac-arm64.dmg", x64: "https://example.test/mac-x64.dmg" },
      windows: "https://example.test/win.exe",
      linux: {
        x64: "https://example.test/linux-x86_64.AppImage",
        arm64: "https://example.test/linux-arm64.AppImage",
      },
    };
    expect(parseReleaseDownloadsSnapshot(valid)).not.toBeNull();
    for (const invalid of [
      { ...valid, version: "" },
      { ...valid, releasesUrl: "" },
      { ...valid, windows: "" },
      { ...valid, mac: { ...valid.mac, arm64: "" } },
      { ...valid, mac: { ...valid.mac, x64: "" } },
      { ...valid, linux: { ...valid.linux, x64: "" } },
      { ...valid, linux: { ...valid.linux, arm64: "" } },
    ]) {
      expect(parseReleaseDownloadsSnapshot(invalid)).toBeNull();
    }
  });

  it("anchors the patterns to the installer suffix", () => {
    expect(RELEASE_ASSET_PATTERNS.macArm64.test("Synara-1.5.1-arm64.dmg")).toBe(true);
    expect(RELEASE_ASSET_PATTERNS.macArm64.test("Synara-1.5.1-arm64.zip")).toBe(false);
    expect(RELEASE_ASSET_PATTERNS.linuxX64.test("Synara-1.5.1-x86_64.AppImage")).toBe(true);
    expect(RELEASE_ASSET_PATTERNS.linuxX64.test("Synara-1.5.1-x86_64.AppImage.sha256")).toBe(false);
    expect(RELEASE_ASSET_PATTERNS.linuxX64.test("Synara-1.5.1-x64.AppImage")).toBe(false);
    expect(RELEASE_ASSET_PATTERNS.linuxArm64.test("Synara-1.5.1-arm64.AppImage")).toBe(true);
    expect(RELEASE_ASSET_PATTERNS.linuxArm64.test("Synara-1.5.1-x86_64.AppImage")).toBe(false);
    expect(RELEASE_ASSET_PATTERNS.windows.test("Synara-1.5.1-x64.exe")).toBe(true);
    expect(RELEASE_ASSET_PATTERNS.windows.test("Synara-1.5.1-x64.exe.blockmap")).toBe(false);
  });
});
