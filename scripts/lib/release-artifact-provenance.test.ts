import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectReleaseArtifactDigests,
  linuxPackageArtifacts,
  writeReleaseArtifactProvenance,
} from "./release-artifact-provenance.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeLinuxManifest(root: string, fileName = "Synara-1.2.3-x64.AppImage") {
  const bytes = readFileSync(join(root, fileName));
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  writeFileSync(
    join(root, "latest-linux.yml"),
    `version: 1.2.3\nfiles:\n  - url: ${fileName}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${fileName}\nsha512: ${sha512}\n`,
  );
}

function linuxInput(assetsDirectory: string, target = "AppImage,deb") {
  return {
    assetsDirectory,
    platform: "linux",
    arch: "x64",
    target,
    version: "1.2.3",
    sourceCommit: "a".repeat(40),
    sourceTag: null,
    lockfileSha256: "b".repeat(64),
    publication: false,
    signed: false,
  } as const;
}

function createAssets(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-artifact-provenance-test-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "Synara-1.2.3-x64.AppImage"), "app-image-bytes");
  writeLinuxManifest(root);
  return root;
}

function createWindowsAssets(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-windows-provenance-test-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "Synara-1.2.3-x64.exe"), "unsigned-windows-bytes");
  writeFileSync(join(root, "latest.yml"), "version: 1.2.3\n");
  return root;
}

describe("release artifact provenance", () => {
  it("hashes the exact collected Linux assets into a deterministic manifest", async () => {
    const assetsDirectory = createAssets();
    const result = await writeReleaseArtifactProvenance({
      assetsDirectory,
      platform: "linux",
      arch: "x64",
      target: "AppImage",
      version: "1.2.3",
      sourceCommit: "a".repeat(40),
      sourceTag: null,
      lockfileSha256: "b".repeat(64),
      publication: false,
      signed: false,
    });

    expect(result.path).toBe(join(assetsDirectory, "artifact-linux-x64.provenance.json"));
    expect(result.manifest.target).toBe("AppImage");
    expect(result.manifest.signing).toEqual({
      status: "not-applicable",
      scheme: "none",
      identity: null,
      checks: ["AppImage payload present"],
    });
    expect(result.manifest.artifacts.map((artifact) => artifact.fileName)).toEqual([
      "latest-linux.yml",
      "Synara-1.2.3-x64.AppImage",
    ]);
    expect(
      result.manifest.artifacts.find(
        (artifact) => artifact.fileName === "Synara-1.2.3-x64.AppImage",
      )?.sha256,
    ).toBe(createHash("sha256").update("app-image-bytes").digest("hex"));
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual(result.manifest);
  });

  it("proves every Linux package format the release leg claims to build", async () => {
    const root = mkdtempSync(join(tmpdir(), "synara-linux-packages-provenance-test-"));
    temporaryRoots.push(root);
    writeFileSync(join(root, "Synara-1.2.3-x86_64.AppImage"), "app-image-bytes");
    writeFileSync(join(root, "Synara-1.2.3-x86_64.deb"), "deb-bytes");
    writeFileSync(join(root, "Synara-1.2.3-x86_64.rpm"), "rpm-bytes");
    writeLinuxManifest(root, "Synara-1.2.3-x86_64.AppImage");

    const result = await writeReleaseArtifactProvenance({
      assetsDirectory: root,
      platform: "linux",
      arch: "x64",
      target: "AppImage,deb,rpm",
      version: "1.2.3",
      sourceCommit: "a".repeat(40),
      sourceTag: null,
      lockfileSha256: "b".repeat(64),
      publication: false,
      signed: false,
    });

    expect(result.manifest.signing.checks).toEqual([
      "AppImage payload present",
      "deb payload present",
      "rpm payload present",
    ]);
  });

  it("fails a combined Linux leg that shipped no rpm", async () => {
    const root = mkdtempSync(join(tmpdir(), "synara-linux-missing-rpm-test-"));
    temporaryRoots.push(root);
    writeFileSync(join(root, "Synara-1.2.3-x86_64.AppImage"), "app-image-bytes");
    writeFileSync(join(root, "Synara-1.2.3-x86_64.deb"), "deb-bytes");
    writeLinuxManifest(root, "Synara-1.2.3-x86_64.AppImage");

    await expect(
      writeReleaseArtifactProvenance({
        assetsDirectory: root,
        platform: "linux",
        arch: "x64",
        target: "AppImage,deb,rpm",
        version: "1.2.3",
        sourceCommit: "a".repeat(40),
        sourceTag: null,
        lockfileSha256: "b".repeat(64),
        publication: false,
        signed: false,
      }),
    ).rejects.toThrow("Expected exactly one .rpm artifact, found 0.");
  });

  it("rejects an unknown Linux package target instead of skipping it", () => {
    expect(() => linuxPackageArtifacts("AppImage,snap")).toThrow(
      "Unsupported Linux package target: snap.",
    );
    expect(linuxPackageArtifacts("AppImage, deb ,rpm")).toEqual([".AppImage", ".deb", ".rpm"]);
  });

  it.each(["", "AppImage,", ",rpm", "AppImage,,deb", "deb,deb", "rpm, rpm"])(
    "rejects malformed target %j before recording provenance",
    async (target) => {
      await expect(
        writeReleaseArtifactProvenance(linuxInput(createAssets(), target)),
      ).rejects.toThrow(/empty|unique/);
    },
  );

  it.each(["deb", "rpm"])("requires a single nonempty %s payload", async (target) => {
    const root = createAssets();
    writeFileSync(join(root, `one.${target}`), "");
    await expect(
      writeReleaseArtifactProvenance(linuxInput(root, `AppImage,${target}`)),
    ).rejects.toThrow("payload must not be empty");
    writeFileSync(join(root, `two.${target}`), "second");
    await expect(
      writeReleaseArtifactProvenance(linuxInput(root, `AppImage,${target}`)),
    ).rejects.toThrow("found 2");
  });

  it.each(["deb", "rpm", "deb,rpm"])("does not give %s updater authority", async (target) => {
    const root = createAssets();
    rmSync(join(root, "Synara-1.2.3-x64.AppImage"));
    for (const format of target.split(","))
      writeFileSync(join(root, `Synara.${format}`), "payload");
    await expect(writeReleaseArtifactProvenance(linuxInput(root, target))).rejects.toThrow(
      "must not own Linux updater metadata",
    );
    rmSync(join(root, "latest-linux.yml"));
    const result = await writeReleaseArtifactProvenance(linuxInput(root, target));
    expect(result.manifest.signing.checks).toEqual(
      target.split(",").map((format) => `${format} payload present`),
    );
  });

  it.each([
    "missing",
    "extra-manifest",
    "wrong-version",
    "deb-authority",
    "rpm-authority",
    "wrong-hash",
    "wrong-size",
    "extra-rpm",
  ])("rejects %s in AppImage updater metadata", async (change) => {
    const root = createAssets();
    const path = join(root, "latest-linux.yml");
    const original = readFileSync(path, "utf8");
    if (change === "missing") rmSync(path);
    else if (change === "extra-manifest")
      writeFileSync(join(root, "latest-linux-rpm.yml"), original);
    else
      writeFileSync(
        path,
        change === "wrong-version"
          ? original.replace("version: 1.2.3", "version: 1.2.4")
          : change === "deb-authority"
            ? original.replaceAll(".AppImage", ".deb")
            : change === "rpm-authority"
              ? original.replaceAll(".AppImage", ".rpm")
              : change === "wrong-hash"
                ? original.replace(/sha512: .+/g, "sha512: wrong")
                : change === "wrong-size"
                  ? original.replace("size: 15", "size: 16")
                  : original.replace(
                      "path:",
                      "  - url: Synara.rpm\n    sha512: rpm\n    size: 7\npath:",
                    ),
      );
    await expect(writeReleaseArtifactProvenance(linuxInput(root, "AppImage"))).rejects.toThrow(
      /Linux updater/,
    );
  });

  it("rejects publication without an exact source tag", async () => {
    await expect(
      writeReleaseArtifactProvenance({
        assetsDirectory: createAssets(),
        platform: "linux",
        arch: "x64",
        target: "AppImage",
        version: "1.2.3",
        sourceCommit: "a".repeat(40),
        sourceTag: null,
        lockfileSha256: "b".repeat(64),
        publication: true,
        signed: false,
      }),
    ).rejects.toThrow("requires an exact source tag");
  });

  it("requires and hashes both declared Linux formats in one provenance record", async () => {
    const root = createAssets();
    writeFileSync(join(root, "Synara-1.2.3-amd64.deb"), "deb-bytes");
    const { manifest } = await writeReleaseArtifactProvenance(linuxInput(root));
    expect(manifest.target).toBe("AppImage,deb");
    expect(manifest.signing.checks).toEqual(["AppImage payload present", "deb payload present"]);
    expect(manifest.artifacts.find((artifact) => artifact.fileName.endsWith(".deb"))).toMatchObject(
      {
        size: 9,
        sha256: createHash("sha256").update("deb-bytes").digest("hex"),
      },
    );
  });

  it("fails closed when a combined leg is missing its Debian payload", async () => {
    await expect(writeReleaseArtifactProvenance(linuxInput(createAssets()))).rejects.toThrow(
      "Expected exactly one .deb artifact, found 0",
    );
  });

  it("keeps the AppImage requirement for a combined leg", async () => {
    const root = createAssets();
    rmSync(join(root, "Synara-1.2.3-x64.AppImage"));
    writeFileSync(join(root, "Synara.deb"), "deb-bytes");
    await expect(writeReleaseArtifactProvenance(linuxInput(root))).rejects.toThrow(
      "Expected exactly one .AppImage artifact, found 0",
    );
  });

  it("rejects duplicate or empty Debian payloads", async () => {
    const root = createAssets();
    writeFileSync(join(root, "one.deb"), "");
    await expect(writeReleaseArtifactProvenance(linuxInput(root))).rejects.toThrow(
      "payload must not be empty",
    );
    writeFileSync(join(root, "two.deb"), "second");
    await expect(writeReleaseArtifactProvenance(linuxInput(root))).rejects.toThrow(
      "Expected exactly one .deb artifact, found 2",
    );
  });

  it("allows a standalone Debian package without giving it updater authority", async () => {
    const root = createAssets();
    rmSync(join(root, "Synara-1.2.3-x64.AppImage"));
    writeFileSync(join(root, "Synara.deb"), "deb-bytes");
    await expect(writeReleaseArtifactProvenance(linuxInput(root, "deb"))).rejects.toThrow(
      "must not own Linux updater metadata",
    );
    rmSync(join(root, "latest-linux.yml"));
    const result = await writeReleaseArtifactProvenance(linuxInput(root, "deb"));
    expect(result.manifest.signing.checks).toEqual(["deb payload present"]);
  });

  it("rejects a second manifest authority and missing AppImage metadata", async () => {
    const root = createAssets();
    writeFileSync(join(root, "latest-linux-deb.yml"), "version: 1.2.3\n");
    await expect(writeReleaseArtifactProvenance(linuxInput(root, "AppImage"))).rejects.toThrow(
      "Expected exactly one Linux updater manifest",
    );
    rmSync(join(root, "latest-linux-deb.yml"));
    rmSync(join(root, "latest-linux.yml"));
    await expect(writeReleaseArtifactProvenance(linuxInput(root, "AppImage"))).rejects.toThrow(
      "Expected exactly one Linux updater manifest",
    );
  });

  it.each([".deb", "wrong-hash", "wrong-size", "extra-deb"])(
    "rejects %s in AppImage-owned metadata",
    async (change) => {
      const root = createAssets();
      const path = join(root, "latest-linux.yml");
      const original = readFileSync(path, "utf8");
      const next =
        change === ".deb"
          ? original.replaceAll(".AppImage", ".deb")
          : change === "wrong-hash"
            ? original.replace(/sha512: .+/g, "sha512: wrong")
            : change === "wrong-size"
              ? original.replace("size: 15", "size: 16")
              : original.replace(
                  "path:",
                  "  - url: Synara.deb\n    sha512: deb\n    size: 9\npath:",
                );
      writeFileSync(path, next);
      await expect(writeReleaseArtifactProvenance(linuxInput(root, "AppImage"))).rejects.toThrow(
        /Linux updater metadata/,
      );
    },
  );

  it("rejects empty, duplicate and unsupported target declarations", () => {
    expect(linuxPackageArtifacts("AppImage, deb")).toEqual([".AppImage", ".deb"]);
    for (const target of [
      "",
      " ",
      "AppImage,",
      ",deb",
      "AppImage,,deb",
      "deb,deb",
      "AppImage,snap",
      "appimage",
    ]) {
      expect(() => linuxPackageArtifacts(target)).toThrow();
    }
  });

  it("collects only regular, uniquely named files inside the asset directory", async () => {
    const root = createAssets();
    writeFileSync(join(root, "old.provenance.json"), "ignored");
    expect((await collectReleaseArtifactDigests(root)).map((file) => file.fileName)).not.toContain(
      "old.provenance.json",
    );
    await expect(
      collectReleaseArtifactDigests(root, ["latest-linux.yml", "latest-linux.yml"]),
    ).rejects.toThrow("must be unique");
    await expect(collectReleaseArtifactDigests(root, ["../outside.deb"])).rejects.toThrow(
      "plain file name",
    );
    mkdirSync(join(root, "directory.deb"));
    await expect(collectReleaseArtifactDigests(root, ["directory.deb"])).rejects.toThrow(
      "regular file",
    );
    symlinkSync(join(root, "latest-linux.yml"), join(root, "linked.deb"));
    await expect(collectReleaseArtifactDigests(root, ["linked.deb"])).rejects.toThrow(
      "regular file",
    );
  });

  it("records an explicit version-scoped unsigned Windows publication", async () => {
    const result = await writeReleaseArtifactProvenance({
      assetsDirectory: createWindowsAssets(),
      platform: "win",
      arch: "x64",
      target: "nsis",
      version: "1.2.3",
      sourceCommit: "a".repeat(40),
      sourceTag: "v1.2.3",
      lockfileSha256: "b".repeat(64),
      publication: true,
      signed: false,
      allowUnsignedWindowsPublication: true,
    });

    expect(result.manifest.signing).toEqual({
      status: "unsigned-explicit-release",
      scheme: "none",
      identity: null,
      checks: ["explicit version-scoped Windows release exception"],
    });
  });

  it("still rejects unsigned Windows publication without the explicit exception", async () => {
    await expect(
      writeReleaseArtifactProvenance({
        assetsDirectory: createWindowsAssets(),
        platform: "win",
        arch: "x64",
        target: "nsis",
        version: "1.2.3",
        sourceCommit: "a".repeat(40),
        sourceTag: "v1.2.3",
        lockfileSha256: "b".repeat(64),
        publication: true,
        signed: false,
      }),
    ).rejects.toThrow("requires verified signing");
  });
});
