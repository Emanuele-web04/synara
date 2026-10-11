import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  // Electron Builder's AppImage target emits x86_64 while provenance records x64.
  const nativeFileArch = platform === "linux" ? "x86_64" : "x64";
  const stem = `${flavor === "beta" ? "Synara-Beta" : "Synara"}-${version}-${nativeFileArch}`;
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

function signedWindowsCheckpoint() {
  const fixture = checkpoint("win");
  fixture.changeManifest((manifest) => {
    manifest.signing = {
      status: "verified",
      scheme: "windows-authenticode",
      identity: [
        {
          fileName: "Synara-1.2.3-x64.exe",
          publisher: "Acme",
          subject: "O=Acme Software, CN=Acme, C=IT",
          thumbprint: "C".repeat(40),
          timestampSubject: "CN=Timestamp Authority",
          timestampThumbprint: "D".repeat(40),
        },
      ],
      checks: ["publisher exact match", "subject DN field match"],
    };
  });
  return {
    ...fixture,
    input: {
      ...fixture.input,
      allowUnsignedWindowsPublication: false,
      expectedWindowsPublisher: "Acme",
      expectedWindowsSubjectDn: "CN=Acme, O=Acme Software, C=IT",
    },
  };
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
    "accepts the native producer's %s %s payload and its full inventory",
    async (platform, flavor) => {
      const { input } = checkpoint(platform, flavor);
      const verified = await verifyReleaseArtifactCheckpoint(input);
      expect(verified.source.commit).toBe(input.sourceCommit);
    },
  );

  it("rejects a Linux AppImage using the manifest architecture alias", async () => {
    const { input, payloadPath, changeManifest } = checkpoint();
    const incorrectFileName = "Synara-1.2.3-x64.AppImage";
    renameSync(payloadPath, join(input.assetsDirectory, incorrectFileName));
    changeManifest((manifest) => {
      manifest.artifacts[0].fileName = incorrectFileName;
    });
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow(
      "unexpected or duplicate artifact name",
    );
  });

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

  it("rechecks the current subject DN even when the Windows publisher is unchanged", async () => {
    const { input } = signedWindowsCheckpoint();
    // The existing normalizer accepts the reordered fields from native certificate output.
    await expect(verifyReleaseArtifactCheckpoint(input)).resolves.toMatchObject({
      signing: { status: "verified" },
    });
    await expect(
      verifyReleaseArtifactCheckpoint({
        ...input,
        expectedWindowsSubjectDn: "CN=Acme, O=Different Organization, C=IT",
      }),
    ).rejects.toThrow("Windows subject DN");
  });

  it.each([
    ["expectedMacTeamId", "mac", "expected team ID"],
    ["expectedWindowsPublisher", "win", "expected publisher"],
    ["expectedWindowsSubjectDn", "win", "expected subject DN"],
  ] as const)("requires %s for a retained signed receipt", async (key, platform, message) => {
    const fixture = platform === "mac" ? checkpoint("mac") : signedWindowsCheckpoint();
    const missing: ReleaseArtifactCheckpointInput = { ...fixture.input };
    const { [key]: _omitted, ...withoutIdentity } = missing;
    await expect(verifyReleaseArtifactCheckpoint(withoutIdentity)).rejects.toThrow(message);
    await expect(verifyReleaseArtifactCheckpoint({ ...missing, [key]: "   " })).rejects.toThrow(
      message,
    );
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

function linuxPackageCheckpoint(target: string, flavor: "production" | "beta" = "production") {
  const fixture = checkpoint("linux", flavor);
  const name = flavor === "beta" ? "Synara-Beta" : "Synara";
  const formats = target.split(",");
  const files = formats.map(
    (format) =>
      `${name}-${fixture.input.version}-${format === "deb" ? "amd64" : "x86_64"}.${format}`,
  );
  if (formats.includes("AppImage")) files.push("latest-linux.yml");
  fixture.changeManifest((manifest) => {
    for (const artifact of manifest.artifacts)
      rmSync(join(fixture.input.assetsDirectory, artifact.fileName));
    manifest.target = target;
    manifest.artifacts = files.map((fileName) => {
      const bytes =
        fileName === "latest-linux.yml"
          ? `version: ${fixture.input.version}\n`
          : `original ${fileName} bytes`;
      writeFileSync(join(fixture.input.assetsDirectory, fileName), bytes);
      return {
        fileName,
        size: Buffer.byteLength(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
  });
  return { ...fixture, input: { ...fixture.input, target } };
}

describe("declared Linux checkpoint formats", () => {
  it.each([
    ["AppImage,deb,rpm", "production"],
    ["AppImage,deb,rpm", "beta"],
    ["AppImage,deb", "production"],
    ["AppImage,deb", "beta"],
    ["AppImage,rpm", "production"],
    ["AppImage,rpm", "beta"],
    ["deb", "production"],
    ["deb", "beta"],
    ["rpm", "production"],
    ["rpm", "beta"],
    ["deb,rpm", "production"],
    ["deb,rpm", "beta"],
  ] as const)(
    "accepts every requested %s payload for %s with native architecture aliases",
    async (target, flavor) => {
      const { input } = linuxPackageCheckpoint(target, flavor);
      await expect(verifyReleaseArtifactCheckpoint(input)).resolves.toMatchObject({ target });
    },
  );

  it("requires a declared Debian payload even when AppImage and provenance remain valid", async () => {
    const { input, changeManifest } = linuxPackageCheckpoint("AppImage,deb,rpm");
    changeManifest((manifest) => {
      const deb = manifest.artifacts.find((entry: { fileName: string }) =>
        entry.fileName.endsWith(".deb"),
      );
      rmSync(join(input.assetsDirectory, deb.fileName));
      manifest.artifacts = manifest.artifacts.filter(
        (entry: { fileName: string }) => entry !== deb,
      );
    });
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow("missing required asset");
  });

  it("requires a declared RPM payload even when AppImage and provenance remain valid", async () => {
    const { input, changeManifest } = linuxPackageCheckpoint("AppImage,deb,rpm");
    changeManifest((manifest) => {
      const rpm = manifest.artifacts.find((entry: { fileName: string }) =>
        entry.fileName.endsWith(".rpm"),
      );
      rmSync(join(input.assetsDirectory, rpm.fileName));
      manifest.artifacts = manifest.artifacts.filter(
        (entry: { fileName: string }) => entry !== rpm,
      );
    });
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow("missing required asset");
  });

  it("rejects an empty declared Debian payload with a matching empty digest", async () => {
    const { input, changeManifest } = linuxPackageCheckpoint("AppImage,deb,rpm");
    changeManifest((manifest) => {
      const deb = manifest.artifacts.find((entry: { fileName: string }) =>
        entry.fileName.endsWith(".deb"),
      );
      writeFileSync(join(input.assetsDirectory, deb.fileName), "");
      deb.size = 0;
      deb.sha256 = createHash("sha256").update("").digest("hex");
    });
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow("digest");
  });

  it("rejects Debian files using x64 instead of the native amd64 name", async () => {
    const { input, changeManifest } = linuxPackageCheckpoint("AppImage,deb,rpm");
    changeManifest((manifest) => {
      const deb = manifest.artifacts.find((entry: { fileName: string }) =>
        entry.fileName.endsWith(".deb"),
      );
      const wrong = deb.fileName.replace("-amd64.deb", "-x64.deb");
      renameSync(join(input.assetsDirectory, deb.fileName), join(input.assetsDirectory, wrong));
      deb.fileName = wrong;
    });
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow(
      "unexpected or duplicate artifact name",
    );
  });

  it("rejects changed Debian bytes with the same size", async () => {
    const { input } = linuxPackageCheckpoint("AppImage,deb,rpm");
    const manifest = JSON.parse(
      readFileSync(join(input.assetsDirectory, "artifact-linux-x64.provenance.json"), "utf8"),
    );
    const deb = manifest.artifacts.find((entry: { fileName: string }) =>
      entry.fileName.endsWith(".deb"),
    );
    writeFileSync(join(input.assetsDirectory, deb.fileName), Buffer.alloc(deb.size, 0x58));
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow("checksum");
  });

  it("rejects an undeclared tar.gz even when its digest matches", async () => {
    const { input, changeManifest } = linuxPackageCheckpoint("AppImage,deb");
    const fileName = "Synara-1.2.3-x86_64.tar.gz";
    writeFileSync(join(input.assetsDirectory, fileName), "extra");
    changeManifest((manifest) => {
      manifest.artifacts.push({
        fileName,
        size: 5,
        sha256: createHash("sha256").update("extra").digest("hex"),
      });
    });
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow(
      "unexpected or duplicate artifact name",
    );
  });

  it("requires the same target declaration in the retained provenance", async () => {
    const { input, changeManifest } = linuxPackageCheckpoint("AppImage,deb,rpm");
    changeManifest((manifest) => {
      manifest.target = "AppImage";
    });
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow("target");
  });

  it.each(["", "AppImage,", "deb,deb", "AppImage,tar.gz"])(
    "rejects unsupported target %s before filesystem reuse",
    async (target) => {
      const { input } = checkpoint();
      await expect(verifyReleaseArtifactCheckpoint({ ...input, target })).rejects.toThrow();
    },
  );

  it("rejects an updater manifest on a package-manager-only checkpoint", async () => {
    const { input, changeManifest } = linuxPackageCheckpoint("deb");
    writeFileSync(join(input.assetsDirectory, "latest-linux.yml"), "extra");
    changeManifest((manifest) => {
      manifest.artifacts.push({
        fileName: "latest-linux.yml",
        size: 5,
        sha256: createHash("sha256").update("extra").digest("hex"),
      });
    });
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow(
      "unexpected or duplicate artifact name",
    );
  });
});

it("retains native Linux inspection tools when a checkpoint skips workspace installation", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/release-platform.yml", import.meta.url),
    "utf8",
  );
  const start = workflow.indexOf("      - name: Install Linux checkpoint inspection tools");
  const end = workflow.indexOf(
    "      - name: Verify Windows installer with Microsoft Defender",
    start,
  );
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const prerequisites = workflow.slice(start, end);
  expect(prerequisites).toContain(
    "if: inputs.platform == 'linux' && steps.restore_checkpoint.outcome == 'success'\n",
  );
  expect(prerequisites).toContain("dpkg-dev xz-utils xvfb xauth");
  expect(prerequisites).toContain("rpm rpm2cpio cpio");
});
