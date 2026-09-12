import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXPECTED_KWIN_PREBUILDS,
  assembleKWinPluginPrebuilds,
} from "./assemble-kwin-plugin-prebuilds.mjs";

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDirectories(): Promise<{ sourceDirectory: string; outputDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), "synara-kwin-assembly-"));
  tempRoots.push(root);
  const sourceDirectory = join(root, "downloaded");
  const outputDirectory = join(root, "prebuilt");
  await mkdir(sourceDirectory);
  return { sourceDirectory, outputDirectory };
}

async function writeBuild(
  sourceDirectory: string,
  build: { builtOn: string; kwinVersion: string; arch: string; file: string },
): Promise<void> {
  await writeFile(join(sourceDirectory, build.file), `bytes for ${build.file}`);
  await writeFile(join(sourceDirectory, `${build.file}.json`), JSON.stringify(build));
}

describe("KWin prebuild assembly", () => {
  it("retains all 11 matrix outputs when every distro ships the same KWin", async () => {
    const paths = await tempDirectories();
    for (const [builtOn, arch] of EXPECTED_KWIN_PREBUILDS) {
      await writeBuild(paths.sourceDirectory, {
        builtOn,
        arch,
        kwinVersion: "6.7.3",
        file: `${builtOn}-${arch}.so`,
      });
    }
    const result = assembleKWinPluginPrebuilds({ ...paths, strict: true, log: () => undefined });
    expect(result.builds).toHaveLength(11);
    expect(result.missing).toEqual([]);
  });

  it("does not count metadata whose binary is missing toward strict coverage", async () => {
    const paths = await tempDirectories();
    for (const [builtOn, arch] of EXPECTED_KWIN_PREBUILDS) {
      await writeBuild(paths.sourceDirectory, {
        builtOn,
        arch,
        kwinVersion: "6.7.3",
        file: `${builtOn}-${arch}.so`,
      });
    }
    await rm(join(paths.sourceDirectory, "arch-x64.so"));
    expect(() =>
      assembleKWinPluginPrebuilds({ ...paths, strict: true, log: () => undefined }),
    ).toThrow("1 missing build");
  });

  it("rejects a filename the runtime manifest reader cannot select", async () => {
    const paths = await tempDirectories();
    await writeFile(
      join(paths.sourceDirectory, "invalid.so.json"),
      JSON.stringify({
        builtOn: "arch",
        arch: "x64",
        kwinVersion: "6.7.3",
        file: "bad\\name.so",
      }),
    );
    expect(() => assembleKWinPluginPrebuilds({ ...paths, log: () => undefined })).toThrow(
      "Invalid KWin prebuild metadata",
    );
  });

  it("retains two distro builds with the same KWin version and architecture", async () => {
    const paths = await tempDirectories();
    await writeBuild(paths.sourceDirectory, {
      builtOn: "fedora-43",
      kwinVersion: "6.7.3",
      arch: "x64",
      file: "fedora.so",
    });
    await writeBuild(paths.sourceDirectory, {
      builtOn: "debian-trixie",
      kwinVersion: "6.7.3",
      arch: "x64",
      file: "debian.so",
    });

    const result = assembleKWinPluginPrebuilds({
      ...paths,
      strict: true,
      expected: [
        ["fedora-43", "x64"],
        ["debian-trixie", "x64"],
      ],
      log: () => undefined,
    });
    expect(result.builds.map((build: { builtOn: string }) => build.builtOn)).toEqual([
      "debian-trixie",
      "fedora-43",
    ]);
    const manifest = JSON.parse(
      await readFile(join(paths.outputDirectory, "manifest.json"), "utf8"),
    );
    expect(manifest.builds).toHaveLength(2);
  });

  it("rejects a true selector collision instead of silently choosing one", async () => {
    const paths = await tempDirectories();
    for (const file of ["first.so", "second.so"]) {
      await writeBuild(paths.sourceDirectory, {
        builtOn: "fedora-43",
        kwinVersion: "6.7.3",
        arch: "x64",
        file,
      });
    }
    expect(() =>
      assembleKWinPluginPrebuilds({ ...paths, expected: [], log: () => undefined }),
    ).toThrow(/Duplicate KWin prebuild selector/);
  });

  it("checks strict coverage against retained manifest entries", async () => {
    const paths = await tempDirectories();
    await writeBuild(paths.sourceDirectory, {
      builtOn: "fedora-43",
      kwinVersion: "6.7.3",
      arch: "x64",
      file: "fedora.so",
    });
    expect(() =>
      assembleKWinPluginPrebuilds({
        ...paths,
        strict: true,
        expected: [
          ["fedora-43", "x64"],
          ["fedora-44", "x64"],
        ],
        log: () => undefined,
      }),
    ).toThrow(/coverage failed with 1 missing build/);
  });
});
