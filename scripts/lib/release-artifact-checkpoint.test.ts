import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type ReleaseArtifactCheckpointInput,
  verifyReleaseArtifactCheckpoint,
} from "./release-artifact-checkpoint.ts";
import type { ReleaseArtifactProvenanceManifest } from "./release-artifact-provenance.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function checkpoint(
  platform: "linux" | "mac" | "win" = "linux",
  flavor: "production" | "beta" = "production",
) {
  const assetsDirectory = mkdtempSync(join(tmpdir(), "synara-checkpoint-"));
  roots.push(assetsDirectory);
  const version = flavor === "beta" ? "1.2.3-beta.1" : "1.2.3";
  const stem = `${flavor === "beta" ? "Synara-Beta" : "Synara"}-${version}-x64`;
  const payload = `${stem}.${platform === "mac" ? "dmg" : platform === "win" ? "exe" : "AppImage"}`;
  const updater =
    platform === "mac"
      ? "latest-mac-x64.yml"
      : platform === "win"
        ? "latest.yml"
        : "latest-linux.yml";
  const files = platform === "mac" ? [payload, `${stem}.zip`, updater] : [payload, updater];
  const signing: ReleaseArtifactProvenanceManifest["signing"] =
    platform === "mac"
      ? {
          status: "verified",
          scheme: "apple-developer-id",
          identity: {
            teamId: "EXPECTEDTEAM",
            authorities: ["Developer ID Application"],
            appBundle: "Synara.app",
            diskImage: payload,
          },
          checks: ["codesign --verify app", "stapler validate app"],
        }
      : {
          status: platform === "win" ? "unsigned-explicit-release" : "not-applicable",
          scheme: "none",
          identity: null,
          checks: ["packaging policy verified"],
        };
  const input: ReleaseArtifactCheckpointInput = {
    assetsDirectory,
    platform,
    arch: "x64",
    target: platform === "mac" ? "dmg" : platform === "win" ? "nsis" : "AppImage",
    version,
    flavor,
    sourceCommit: "a".repeat(40),
    sourceTag: `v${version}`,
    lockfileSha256: "b".repeat(64),
    publication: true,
    allowUnsignedWindowsPublication: platform === "win",
    expectedMacTeamId: "EXPECTEDTEAM",
  };
  const manifest: ReleaseArtifactProvenanceManifest = {
    schemaVersion: 1,
    platform,
    arch: input.arch,
    target: input.target,
    version,
    publication: true,
    source: {
      commit: input.sourceCommit,
      tag: input.sourceTag,
      lockfileSha256: input.lockfileSha256,
    },
    signing,
    artifacts: files.map((fileName) => {
      const bytes = fileName === updater ? `version: ${version}\n` : "original package bytes";
      writeFileSync(join(assetsDirectory, fileName), bytes);
      return {
        fileName,
        size: Buffer.byteLength(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  };
  const manifestPath = join(assetsDirectory, `artifact-${platform}-x64.provenance.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  function changeManifest(change: (value: Record<string, any>) => void) {
    const value = JSON.parse(readFileSync(manifestPath, "utf8"));
    change(value);
    writeFileSync(manifestPath, JSON.stringify(value));
  }
  return { input, manifestPath, payloadPath: join(assetsDirectory, payload), changeManifest };
}

describe("same-run release artifact checkpoint", () => {
  it.each([
    ["linux", "production"],
    ["linux", "beta"],
    ["mac", "production"],
    ["mac", "beta"],
    ["win", "production"],
    ["win", "beta"],
  ] as const)(
    "accepts the unchanged %s %s payload and its full inventory",
    async (platform, flavor) => {
      const { input } = checkpoint(platform, flavor);
      const verified = await verifyReleaseArtifactCheckpoint(input);
      expect(verified.source.commit).toBe(input.sourceCommit);
    },
  );

  it.each([
    ["source commit", { sourceCommit: "c".repeat(40) }],
    ["lockfile", { lockfileSha256: "d".repeat(64) }],
    ["publication", { publication: false }],
    ["source tag", { sourceTag: null, publication: false }],
  ])("rejects a checkpoint from a different %s", async (field, change) => {
    const { input, changeManifest } = checkpoint();
    // Keep publication equal for the tag case so it reaches the tag contract.
    if (field === "source tag")
      changeManifest((manifest) => {
        manifest.publication = false;
      });
    await expect(verifyReleaseArtifactCheckpoint({ ...input, ...change })).rejects.toThrow(
      `Checkpoint ${field}`,
    );
  });

  it("rejects changed bytes even when the file size is unchanged", async () => {
    const { input, payloadPath } = checkpoint();
    writeFileSync(payloadPath, "modified package bytes");
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow("checksum");
  });

  it.each(["extra", "missing", "symlink", "extra provenance"])(
    "rejects a %s entry at the filesystem boundary",
    async (kind) => {
      const { input, payloadPath } = checkpoint();
      if (kind === "extra") writeFileSync(join(input.assetsDirectory, "unlisted.exe"), "unlisted");
      if (kind === "extra provenance")
        writeFileSync(join(input.assetsDirectory, "other.provenance.json"), "{}");
      if (kind === "missing" || kind === "symlink") rmSync(payloadPath);
      if (kind === "symlink") symlinkSync("latest-linux.yml", payloadPath);
      await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow(
        kind === "symlink" ? "regular file" : kind === "missing" ? "ENOENT" : "inventory",
      );
    },
  );

  it.each(["../outside.exe", "C:\\outside.exe", "/outside.exe"])(
    "rejects manifest path %s before reading it",
    async (fileName) => {
      const { input, changeManifest } = checkpoint();
      changeManifest((manifest) => {
        manifest.artifacts[0].fileName = fileName;
      });
      await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow(
        "unexpected or duplicate artifact name",
      );
    },
  );

  it("rejects a duplicate inventory entry and an omitted required payload", async () => {
    const { input, changeManifest } = checkpoint();
    changeManifest((manifest) => {
      manifest.artifacts.push(manifest.artifacts[0]);
    });
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow("duplicate artifact name");
    changeManifest((manifest) => {
      manifest.artifacts = [manifest.artifacts[1]];
    });
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow("missing required asset");
  });

  it("rejects Stable payload names when qualifying the Beta flavor", async () => {
    const { input } = checkpoint();
    await expect(verifyReleaseArtifactCheckpoint({ ...input, flavor: "beta" })).rejects.toThrow(
      "unexpected or duplicate artifact name",
    );
  });

  it("requires the current version-scoped Windows exception on every qualification", async () => {
    const { input } = checkpoint("win");
    await expect(
      verifyReleaseArtifactCheckpoint({ ...input, allowUnsignedWindowsPublication: false }),
    ).rejects.toThrow("requires verified signing");
  });

  it("rejects unsigned macOS publication and signing receipts from another team", async () => {
    const { input, changeManifest } = checkpoint("mac");
    await expect(
      verifyReleaseArtifactCheckpoint({ ...input, expectedMacTeamId: "OTHERTEAM" }),
    ).rejects.toThrow("macOS team");
    changeManifest((manifest) => {
      manifest.signing = {
        status: "unsigned-build-only",
        scheme: "none",
        identity: null,
        checks: ["publication disabled"],
      };
    });
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow(
      "requires verified signing",
    );
  });
});
