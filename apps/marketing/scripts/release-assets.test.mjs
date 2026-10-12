import assert from "node:assert/strict";
import { test } from "node:test";
import { findReleaseAssetUrl, isInstallerAsset } from "../src/lib/release-assets.ts";

test("counts actual Deb and RPM installers without counting metadata", () => {
  for (const name of [
    "Synara.dmg",
    "Synara.exe",
    "Synara.AppImage",
    "Synara-amd64.deb",
    "Synara-x86_64.rpm",
  ])
    assert.equal(isInstallerAsset(name), true, name);
  for (const name of [
    undefined,
    "latest-linux.yml",
    "Synara.rpm.sha256",
    "Synara.AppImage.blockmap",
    "artifact-linux-x64.provenance.json",
  ])
    assert.equal(isInstallerAsset(name), false, String(name));
});

test("maps all three Linux formats and preserves absent package availability", () => {
  const assets = [
    { name: "Synara.AppImage", browser_download_url: "https://example.invalid/Synara.AppImage" },
    { name: "Synara-amd64.deb", browser_download_url: "https://example.invalid/Synara-amd64.deb" },
    {
      name: "Synara-x86_64.rpm",
      browser_download_url: "https://example.invalid/Synara-x86_64.rpm",
    },
  ];
  for (const extension of ["AppImage", "deb", "rpm"])
    assert.equal(
      findReleaseAssetUrl(assets, new RegExp(`\\.${extension}$`, "i")),
      assets.find((asset) => asset.name.endsWith(extension)).browser_download_url,
    );
  assert.equal(findReleaseAssetUrl(assets.slice(0, 1), /\.deb$/i), null);
  assert.equal(findReleaseAssetUrl(assets.slice(0, 1), /\.rpm$/i), null);
  assert.equal(findReleaseAssetUrl([{ name: "Synara.rpm" }], /\.rpm$/i), null);
});
