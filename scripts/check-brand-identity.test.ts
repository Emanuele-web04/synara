import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  findBrandIdentityViolations,
  findVisualBrandAssetViolations,
  readTrackedFiles,
} from "./check-brand-identity";

const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const shortName = characters(116, 51);
const firstName = `${shortName}${characters(99, 111, 100, 101)}`;
const firstDisplayName = characters(84, 51, 67, 111, 100, 101);
const firstSpacedDisplayName = `${characters(84, 51)} Code`;
const secondName = characters(100, 112, 99, 111, 100, 101);
const companyDisplayName = `${characters(84, 51)} ${characters(84, 111, 111, 108, 115)}`;
const legalNotice = `Copyright (c) 2026 ${companyDisplayName} Inc.`;
const originsAttribution = `Synara began as a clone of [${firstDisplayName}](https://github.com/pingdotgg/${firstName}), but it has since become a substantially different product with its own branding, packaging, release system, provider orchestration, desktop app behavior, and product direction.`;
const releaseAttribution = `**A review of the Synara codebase found an analytics configuration that came from the original ${firstSpacedDisplayName} codebase when Synara was created as a clone in March. We did not add it, and we have no access to the PostHog project receiving the events.**`;
const inAppReleaseAttribution = `"A review of the Synara codebase found an analytics configuration that came from the original ${firstSpacedDisplayName} codebase when Synara was created as a clone in March.",`;

describe("brand identity guard", () => {
  it("scans owned files while ignoring initialized and absent gitlinks", () => {
    const cwd = mkdtempSync(join(tmpdir(), "synara-brand-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    try {
      git("init", "--quiet");
      const path = "source with spaces.ts";
      writeFileSync(join(cwd, path), `const value = "${secondName}:state";`);
      git("add", "--", path);
      const oid = git("hash-object", "-w", path);
      git("update-index", "--add", "--cacheinfo", `160000,${oid},nested`);
      git("update-index", "--add", "--cacheinfo", `160000,${oid},absent`);
      mkdirSync(join(cwd, "nested"));
      writeFileSync(join(cwd, "nested", "outside.ts"), firstName);

      const files = readTrackedFiles(cwd);
      expect(files.map((file) => file.path)).toEqual([path]);
      expect(
        findBrandIdentityViolations(
          files.map((file) => ({ ...file, contents: Buffer.from(file.contents).toString("utf8") })),
        ),
      ).toHaveLength(1);

      // missing owned files must fail, not silently weaken the guard
      rmSync(join(cwd, path));
      expect(() => readTrackedFiles(cwd)).toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("detects retired names in paths and text", () => {
    const violations = findBrandIdentityViolations([
      { path: `docs/${firstName}.md`, contents: "Synara" },
      { path: "source.ts", contents: `const value = "${secondName}:state";` },
    ]);
    expect(violations).toHaveLength(2);
  });

  it("does not match ordinary numeric type names or canonical Synara text", () => {
    expect(
      findBrandIdentityViolations([
        { path: "source.ts", contents: "const value = new Uint32Array(); // Synara" },
      ]),
    ).toEqual([]);
  });

  it("allows the exact legal attribution once in LICENSE", () => {
    expect(findBrandIdentityViolations([{ path: "LICENSE", contents: legalNotice }])).toEqual([]);
    expect(
      findBrandIdentityViolations([{ path: "docs/license-copy.md", contents: legalNotice }]),
    ).toHaveLength(1);
    expect(
      findBrandIdentityViolations([
        { path: "LICENSE", contents: `${legalNotice}\n${legalNotice}` },
      ]),
    ).toHaveLength(1);
  });

  it("allows the exact predecessor attribution only in the README Origins section", () => {
    expect(
      findBrandIdentityViolations([
        { path: "README.md", contents: `## Origins\n\n${originsAttribution}` },
      ]),
    ).toEqual([]);
    expect(
      findBrandIdentityViolations([
        { path: "README.md", contents: `## About\n\n${originsAttribution}` },
      ]),
    ).toHaveLength(1);
    expect(
      findBrandIdentityViolations([
        {
          path: "README.md",
          contents: `## Origins\n\n${originsAttribution}\nLegacy ${firstName}`,
        },
      ]),
    ).toHaveLength(1);
  });

  it("allows the exact 0.7.0 release attribution only in its approved locations", () => {
    expect(
      findBrandIdentityViolations([
        { path: "CHANGELOG.md", contents: `## 0.7.0 - 2026-08-05\n\n${releaseAttribution}` },
        {
          path: "apps/web/src/whatsNew/entries.ts",
          contents: inAppReleaseAttribution,
        },
      ]),
    ).toEqual([]);
    expect(
      findBrandIdentityViolations([
        { path: "CHANGELOG.md", contents: `## 0.6.7 - 2026-08-05\n\n${releaseAttribution}` },
        { path: "apps/web/src/other.ts", contents: inAppReleaseAttribution },
      ]),
    ).toHaveLength(2);
  });

  it("requires user-facing raster assets to match a visually approved digest", () => {
    const approvedContents = new TextEncoder().encode("approved Synara screenshot");
    const approvedDigest = "a553296ca5a2d3ad7b64a6bc1b36c2834da750eae6611642177482b99ba85bd8";
    const approvedDigests = new Map([["screenshot.jpeg", approvedDigest]]);

    expect(
      findVisualBrandAssetViolations(
        [{ path: "screenshot.jpeg", contents: approvedContents }],
        approvedDigests,
      ),
    ).toEqual([]);
    expect(
      findVisualBrandAssetViolations(
        [{ path: "screenshot.jpeg", contents: new TextEncoder().encode("changed") }],
        approvedDigests,
      ),
    ).toHaveLength(1);
    expect(findVisualBrandAssetViolations([], approvedDigests)).toHaveLength(1);
  });
});
