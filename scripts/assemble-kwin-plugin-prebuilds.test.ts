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
  build: {
    builtOn: string;
    kwinVersion: string;
    arch: string;
    file: string;
    qtVersion?: string;
    kfVersion?: string;
    glibcVersion?: string;
  },
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

  it("carries the recorded toolchain into the manifest and drops unknown (empty) versions", async () => {
    const paths = await tempDirectories();
    await writeBuild(paths.sourceDirectory, {
      builtOn: "fedora-43",
      kwinVersion: "6.7.3",
      arch: "x64",
      file: "fedora.so",
      qtVersion: "6.9.1",
      kfVersion: "6.17.0",
      glibcVersion: "2.41",
    });
    await writeBuild(paths.sourceDirectory, {
      builtOn: "arch",
      kwinVersion: "6.7.3",
      arch: "x64",
      file: "arch.so",
      qtVersion: "",
      kfVersion: "",
      glibcVersion: "",
    });
    assembleKWinPluginPrebuilds({ ...paths, expected: [], log: () => undefined });
    const manifest = JSON.parse(
      await readFile(join(paths.outputDirectory, "manifest.json"), "utf8"),
    );
    expect(manifest.builds).toEqual([
      {
        kwinVersion: "6.7.3",
        arch: "x64",
        builtOn: "arch",
        file: "arch.so",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      {
        kwinVersion: "6.7.3",
        arch: "x64",
        builtOn: "fedora-43",
        file: "fedora.so",
        qtVersion: "6.9.1",
        kfVersion: "6.17.0",
        glibcVersion: "2.41",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  it("rejects a toolchain version that is not a string", async () => {
    const paths = await tempDirectories();
    await writeFile(join(paths.sourceDirectory, "bad.so"), "bytes");
    await writeFile(
      join(paths.sourceDirectory, "bad.so.json"),
      JSON.stringify({
        builtOn: "arch",
        arch: "x64",
        kwinVersion: "6.7.3",
        file: "bad.so",
        qtVersion: 6,
      }),
    );
    expect(() =>
      assembleKWinPluginPrebuilds({ ...paths, expected: [], log: () => undefined }),
    ).toThrow(/Invalid qtVersion/);
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

const WORKFLOW_PATH = join(
  import.meta.dirname,
  "..",
  ".github",
  "workflows",
  "kwin-plugin-prebuilds.yml",
);

/**
 * A purpose-built read of the build job's matrix, enough to derive the
 * (distro, arch) pairs the workflow actually produces. It understands exactly
 * the shapes this file uses - a flow-style `arch: [a, b]`, block-style distro
 * entries whose first key is `id`, and `exclude` items of `- arch: x` followed
 * by a distro whose `id:` is given - and fails loudly on anything else, so a
 * matrix rewrite that this cannot follow fails the test rather than deriving
 * an empty list.
 */
function parseBuildMatrix(workflow: string): {
  arches: string[];
  distros: string[];
  excluded: Array<{ arch: string; distro: string }>;
} {
  const matrixStart = workflow.indexOf("      matrix:\n");
  const matrixEnd = workflow.indexOf("    steps:\n", matrixStart);
  if (matrixStart < 0 || matrixEnd < 0) throw new Error("build matrix not found");
  const matrix = workflow.slice(matrixStart, matrixEnd);

  const archLine = /^\s+arch:\s*\[([^\]]+)\]\s*$/m.exec(matrix);
  if (!archLine?.[1]) throw new Error("matrix.arch is not a flow list");
  const arches = archLine[1].split(",").map((entry) => entry.trim());

  const excludeStart = matrix.indexOf("        exclude:\n");
  const distroSection = excludeStart < 0 ? matrix : matrix.slice(0, excludeStart);
  const distros = [...distroSection.matchAll(/^\s+id:\s*([a-z0-9-]+),?\s*$/gm)].map(
    (match) => match[1]!,
  );
  if (distros.length === 0) throw new Error("matrix.distro has no ids");

  const excluded: Array<{ arch: string; distro: string }> = [];
  if (excludeStart >= 0) {
    const excludeSection = matrix.slice(excludeStart);
    const items = excludeSection.split(/^\s+- arch:\s*/m).slice(1);
    for (const item of items) {
      const arch = /^([a-z0-9]+)\s*$/m.exec(item)?.[1];
      const distro = /^\s+id:\s*([a-z0-9-]+),?\s*$/m.exec(item)?.[1];
      if (!arch || !distro) throw new Error(`unreadable exclude entry: ${item.slice(0, 80)}`);
      excluded.push({ arch, distro });
    }
  }
  return { arches, distros, excluded };
}

describe("KWin prebuild workflow", () => {
  it("expects exactly the (distro, arch) pairs the workflow matrix produces", async () => {
    const { arches, distros, excluded } = parseBuildMatrix(await readFile(WORKFLOW_PATH, "utf8"));
    // Cartesian product in the matrix's own order (distro-major), minus the
    // exclusions, so this list is derived from the workflow and not restated.
    const derived = distros.flatMap((distro) =>
      arches
        .filter((arch) => !excluded.some((entry) => entry.arch === arch && entry.distro === distro))
        .map((arch) => [distro, arch] as const),
    );
    expect(EXPECTED_KWIN_PREBUILDS).toEqual(derived);
    // The parse understood the exclusion the file is known to carry.
    expect(excluded).toEqual([{ arch: "arm64", distro: "arch" }]);
  });

  it("pins every action to a full commit SHA", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");
    const uses = [...workflow.matchAll(/^\s+uses:\s*(\S+)/gm)].map((match) => match[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) {
      // owner/repo@<40 hex>; a tag or branch after the @ is mutable.
      expect(reference).toMatch(/^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/);
    }
  });

  it("downloads every build artifact but never its own assembled output", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");
    const download =
      /uses:\s*actions\/download-artifact@[^\n]+\n(?:.*\n)*?\s+pattern:\s*\|\n((?:\s{12}.*\n)+)/.exec(
        workflow,
      );
    expect(download).not.toBeNull();
    const patterns = download![1]!
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(patterns).toEqual(["kwin-plugin-*", "!kwin-plugin-prebuilt"]);
    // And the excluded name is the one the assemble job really uploads.
    expect(workflow).toMatch(/name:\s*kwin-plugin-prebuilt\s*\n/);
  });
});
