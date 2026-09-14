import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SYNARA_PRODUCTION_BUNDLE_ID, synaraDesktopIdentity } from "@synara/shared/desktopIdentity";
import { describe, expect, it } from "vitest";

import { DESKTOP_ARTIFACT_NAME_TEMPLATE } from "./desktop-artifact-names.ts";
import {
  HOMEBREW_CASK_DESC,
  HOMEBREW_CASK_GITHUB_REPO,
  HOMEBREW_CASK_HOMEPAGE,
  HOMEBREW_CASK_INSTALL_COMMAND,
  HOMEBREW_CASK_MACOS_SYMBOL,
  HOMEBREW_CASK_RELATIVE_PATH,
  homebrewCaskDmgFileName,
  homebrewCaskZapTrash,
  normalizeHomebrewCaskVersion,
  parseGitHubReleaseDigest,
  renderHomebrewCask,
} from "./homebrew-cask.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKED_IN_CASK = join(REPO_ROOT, HOMEBREW_CASK_RELATIVE_PATH);
const BUILD_SCRIPT = join(REPO_ROOT, "scripts/build-desktop-artifact.ts");

const SAMPLE = {
  version: "0.8.4",
  sha256: {
    arm64: "6a957d8cdc7967555303f188dcf67816264cac72e2d377e11071e2d41db2733a",
    x64: "0b28212fa6ac9c3d7bd09a70c38ff36492ac4834ad8641a6361d148e9977c03a",
  },
} as const;

describe("homebrew cask contract", () => {
  it("normalizes v-prefixed versions and keeps DMG names aligned with electron-builder", () => {
    expect(normalizeHomebrewCaskVersion("v0.8.4")).toBe("0.8.4");
    expect(homebrewCaskDmgFileName("v0.8.4", "arm64")).toBe("Synara-0.8.4-arm64.dmg");
    expect(homebrewCaskDmgFileName("0.8.4", "x64")).toBe("Synara-0.8.4-x64.dmg");
    expect(DESKTOP_ARTIFACT_NAME_TEMPLATE).toBe("Synara-${version}-${arch}.${ext}");
    expect(readFileSync(BUILD_SCRIPT, "utf8")).toContain(
      "artifactName: DESKTOP_ARTIFACT_NAME_TEMPLATE",
    );
  });

  it("zaps production identity paths and the Electron updater cache", () => {
    const identity = synaraDesktopIdentity("production");
    const zap = homebrewCaskZapTrash();

    expect(zap).toContain(`~/${identity.defaultHomeDirectoryName}`);
    expect(zap).toContain(`~/Library/Application Support/${identity.userDataDirectoryName}`);
    expect(zap).toContain(`~/Library/Logs/${identity.displayName}`);
    expect(zap).toContain(`~/Library/Caches/${SYNARA_PRODUCTION_BUNDLE_ID}.ShipIt`);
    expect(zap).toEqual(zap.toSorted((left, right) => left.localeCompare(right)));
  });

  it("renders a Gatekeeper-oriented official cask with GitHub livecheck and auto-updates", () => {
    const rendered = renderHomebrewCask(SAMPLE);

    expect(rendered).toContain('cask "synara" do');
    expect(rendered).toContain('arch arm: "arm64", intel: "x64"');
    expect(rendered).toContain('version "0.8.4"');
    expect(rendered).toContain(
      `url "https://github.com/${HOMEBREW_CASK_GITHUB_REPO}/releases/download/v#{version}/Synara-#{version}-#{arch}.dmg"`,
    );
    expect(rendered).toContain(`verified: "github.com/${HOMEBREW_CASK_GITHUB_REPO}/"`);
    expect(rendered).toContain(`homepage "${HOMEBREW_CASK_HOMEPAGE}"`);
    expect(rendered).toContain(`desc "${HOMEBREW_CASK_DESC}"`);
    expect(rendered).toContain("strategy :github_latest");
    expect(rendered).toContain("auto_updates true");
    expect(rendered).toContain(`depends_on macos: ${HOMEBREW_CASK_MACOS_SYMBOL}`);
    expect(rendered).toContain('app "Synara.app"');
    expect(rendered).toContain(`uninstall quit: "${SYNARA_PRODUCTION_BUNDLE_ID}"`);
    expect(rendered.endsWith("end\n")).toBe(true);
    expect(HOMEBREW_CASK_INSTALL_COMMAND).toBe("brew install --cask synara");
  });

  it("keeps the checked-in cask identical to the renderer for the current stable hashes", () => {
    expect(readFileSync(CHECKED_IN_CASK, "utf8")).toBe(renderHomebrewCask(SAMPLE));
  });

  it("parses GitHub release asset digests", () => {
    expect(
      parseGitHubReleaseDigest(
        "sha256:6a957d8cdc7967555303f188dcf67816264cac72e2d377e11071e2d41db2733a",
      ),
    ).toBe(SAMPLE.sha256.arm64);
    expect(() => parseGitHubReleaseDigest("md5:abc")).toThrow(/sha256/);
  });
});
