import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SYNARA_PRODUCTION_BUNDLE_ID, synaraDesktopIdentity } from "@synara/shared/desktopIdentity";
import { describe, expect, it } from "vitest";

import { createDesktopArtifactIdentity } from "./desktop-artifact-identity.ts";
import {
  HOMEBREW_CASK_DESC,
  HOMEBREW_CASK_GITHUB_REPO,
  HOMEBREW_CASK_HOMEPAGE,
  HOMEBREW_CASK_INSTALL_COMMAND,
  HOMEBREW_CASK_MACOS_SYMBOL,
  HOMEBREW_CASK_RELATIVE_PATH,
  homebrewCaskDmgFileName,
  homebrewCaskInputFromGitHubRelease,
  homebrewCaskZapTrash,
  normalizeHomebrewCaskVersion,
  parseGitHubReleaseDigest,
  renderHomebrewCask,
} from "./homebrew-cask.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKED_IN_CASK = join(REPO_ROOT, HOMEBREW_CASK_RELATIVE_PATH);
const RENDER_SCRIPT = join(REPO_ROOT, "scripts/render-homebrew-cask.ts");

const SAMPLE = {
  version: "1.0.1",
  sha256: {
    arm64: "d2e63ec2ff7da36de3531ca95ef8ac2b4161631fee9f94e3da15b31ff393d3ea",
    x64: "c6ce67a500e92c3f26fb885fbf1be2c901aa401f71ff13a8b0bb9a1104df3ddb",
  },
} as const;

describe("homebrew cask contract", () => {
  it("normalizes v-prefixed versions and keeps DMG names aligned with electron-builder", () => {
    expect(normalizeHomebrewCaskVersion("v0.8.4")).toBe("0.8.4");
    expect(homebrewCaskDmgFileName("v0.8.4", "arm64")).toBe("Synara-0.8.4-arm64.dmg");
    expect(homebrewCaskDmgFileName("0.8.4", "x64")).toBe("Synara-0.8.4-x64.dmg");
    expect(
      createDesktopArtifactIdentity({ platform: "mac", flavor: "production" }).buildConfig
        .artifactName,
    ).toBe("Synara-${version}-${arch}.${ext}");
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

  it("renders the proposed cask with GitHub livecheck and auto-updates", () => {
    const rendered = renderHomebrewCask(SAMPLE);

    expect(rendered).toContain('cask "synara" do');
    expect(rendered).toContain('arch arm: "arm64", intel: "x64"');
    expect(rendered).toContain('version "1.0.1"');
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
    expect(parseGitHubReleaseDigest(`sha256:${SAMPLE.sha256.arm64}`)).toBe(SAMPLE.sha256.arm64);
    expect(() => parseGitHubReleaseDigest("md5:abc")).toThrow(/sha256/);
  });

  it.each([
    "",
    "v",
    "1.2",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-beta.1",
    "1.2.3+build",
    "1.2.3/other",
    '1.2.3\"\n  system \"id',
    "1.2.3#{system('id')}",
    "1.2.3\u0000",
  ])("rejects an invalid or unsafe stable version %j before rendering Ruby", (version) => {
    expect(() => normalizeHomebrewCaskVersion(version)).toThrow(/stable X.Y.Z/);
    expect(() => renderHomebrewCask({ ...SAMPLE, version })).toThrow(/stable X.Y.Z/);
  });

  it("normalizes safe manual version and checksum whitespace without retaining it in Ruby", () => {
    expect(
      renderHomebrewCask({
        version: " V1.0.1 ",
        sha256: { arm64: ` ${SAMPLE.sha256.arm64.toUpperCase()} `, x64: SAMPLE.sha256.x64 },
      }),
    ).toBe(renderHomebrewCask(SAMPLE));
  });

  it.each(["", "a".repeat(63), "g".repeat(64), "a".repeat(65), '${system("id")}'])(
    "rejects invalid checksums %j for either architecture",
    (hash) => {
      expect(() =>
        renderHomebrewCask({ ...SAMPLE, sha256: { ...SAMPLE.sha256, arm64: hash } }),
      ).toThrow(/64 hex/);
      expect(() =>
        renderHomebrewCask({ ...SAMPLE, sha256: { ...SAMPLE.sha256, x64: hash } }),
      ).toThrow(/64 hex/);
    },
  );

  it.each([undefined, "sha256:", `sha512:${SAMPLE.sha256.arm64}`, `sha256:${"g".repeat(64)}`])(
    "rejects incomplete or unsupported GitHub digests %j",
    (digest) => {
      expect(() => parseGitHubReleaseDigest(digest)).toThrow(/sha256/);
    },
  );

  it.each([
    ["beta", "Synara-Beta"],
    ["canary", "Synara-Canary"],
    ["cua", "Synara-Cua"],
  ] as const)("preserves the existing %s artifact identity", (flavor, prefix) => {
    expect(
      createDesktopArtifactIdentity({ platform: "mac", flavor }).buildConfig.artifactName,
    ).toBe(`${prefix}-\${version}-\${arch}.\${ext}`);
    const identity = synaraDesktopIdentity(flavor);
    expect(homebrewCaskZapTrash()).not.toContain(`~/${identity.defaultHomeDirectoryName}`);
    expect(homebrewCaskZapTrash()).not.toContain(
      `~/Library/Application Support/${identity.userDataDirectoryName}`,
    );
  });
});

function releaseFixture() {
  return {
    tag_name: "v1.0.1",
    draft: false,
    prerelease: false,
    assets: (["arm64", "x64"] as const).map((arch) => ({
      name: `Synara-1.0.1-${arch}.dmg`,
      state: "uploaded",
      size: 1234,
      digest: `sha256:${SAMPLE.sha256[arch]}`,
      browser_download_url: `https://github.com/${HOMEBREW_CASK_GITHUB_REPO}/releases/download/v1.0.1/Synara-1.0.1-${arch}.dmg`,
    })),
  };
}

describe("GitHub release selection", () => {
  it("accepts both complete stable architecture assets", () => {
    expect(homebrewCaskInputFromGitHubRelease(releaseFixture())).toEqual(SAMPLE);
  });

  it.each([
    { release: null },
    { release: [] },
    { release: {} },
    { release: { ...releaseFixture(), draft: true } },
    { release: { ...releaseFixture(), prerelease: true } },
  ])("rejects unpublished or malformed release data $release", ({ release }) => {
    expect(() => homebrewCaskInputFromGitHubRelease(release)).toThrow(/published stable/);
  });

  it.each([undefined, "1.0.1", "V1.0.1", " v1.0.1 ", "v1.0.1-beta.1", 'v1.0.1\"\nabort'])(
    "requires the canonical stable download tag %j",
    (tag_name) => {
      expect(() => homebrewCaskInputFromGitHubRelease({ ...releaseFixture(), tag_name })).toThrow();
    },
  );

  it("rejects an absent, incomplete or ambiguous asset inventory", () => {
    const release = releaseFixture();
    expect(() => homebrewCaskInputFromGitHubRelease({ ...release, assets: undefined })).toThrow(
      /inventory/,
    );
    expect(() => homebrewCaskInputFromGitHubRelease({ ...release, assets: [] })).toThrow(
      /exactly one/,
    );
    expect(() =>
      homebrewCaskInputFromGitHubRelease({ ...release, assets: release.assets.slice(0, 1) }),
    ).toThrow(/x64/);
    expect(() =>
      homebrewCaskInputFromGitHubRelease({
        ...release,
        assets: [...release.assets, release.assets[0]],
      }),
    ).toThrow(/exactly one/);
  });

  it.each([
    { state: "starter" },
    { size: 0 },
    { size: -1 },
    { size: 1.5 },
    { size: "1234" },
    { browser_download_url: "https://example.com/Synara-1.0.1-arm64.dmg" },
    {
      browser_download_url: `https://github.com/${HOMEBREW_CASK_GITHUB_REPO}/releases/download/v1.0.0/Synara-1.0.1-arm64.dmg`,
    },
    { digest: undefined },
    { digest: 1234 },
    { digest: "md5:abc" },
  ])("rejects incomplete or mismatched assets %j", (change) => {
    const release = releaseFixture();
    expect(() =>
      homebrewCaskInputFromGitHubRelease({
        ...release,
        assets: [{ ...release.assets[0], ...change }, release.assets[1]],
      }),
    ).toThrow();
  });
});

describe("Homebrew renderer CLI", () => {
  const manual = [
    "--version",
    SAMPLE.version,
    "--sha256-arm64",
    SAMPLE.sha256.arm64,
    "--sha256-x64",
    SAMPLE.sha256.x64,
  ];
  const invoke = (args: readonly string[]) =>
    spawnSync(process.execPath, [RENDER_SCRIPT, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });

  it("prints the complete cask without modifying the checked-in source", () => {
    const before = readFileSync(CHECKED_IN_CASK);
    const result = invoke(manual);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(renderHomebrewCask(SAMPLE));
    expect(readFileSync(CHECKED_IN_CASK)).toEqual(before);
  });

  it.each([
    { args: [], error: /Provide --version/ },
    { args: ["--version"], error: /Unknown or incomplete argument: --version/ },
    { args: ["--version", "--write"], error: /Unknown or incomplete argument: --version/ },
    { args: ["--unknown"], error: /Unknown or incomplete argument: --unknown/ },
    { args: ["--from-github", "--version", SAMPLE.version], error: /Do not combine --from-github/ },
    {
      args: ["--from-github", "--from-github"],
      error: /Duplicate or empty argument: --from-github/,
    },
    { args: [...manual, "--version", "2.0.0"], error: /Duplicate or empty argument: --version/ },
    { args: [...manual, "--write"], error: /Duplicate or empty argument: --write/ },
    {
      args: [
        "--version",
        '1.0.1\"\nabort',
        "--sha256-arm64",
        SAMPLE.sha256.arm64,
        "--sha256-x64",
        SAMPLE.sha256.x64,
      ],
      error: /stable X.Y.Z/,
    },
    {
      args: [
        "--version",
        SAMPLE.version,
        "--sha256-arm64",
        "invalid",
        "--sha256-x64",
        SAMPLE.sha256.x64,
      ],
      error: /64 hex/,
    },
  ])("rejects invalid invocation $args before writing or requesting GitHub", ({ args, error }) => {
    const before = readFileSync(CHECKED_IN_CASK);
    const result = invoke([...args, "--write"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(error);
    expect(result.stdout).toBe("");
    expect(readFileSync(CHECKED_IN_CASK)).toEqual(before);
  });
});
