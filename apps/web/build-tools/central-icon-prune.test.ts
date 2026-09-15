import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CENTRAL_ICON_DIRS, pruneCentralIcons } from "./central-icon-prune.ts";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(source: string) {
  const root = await mkdtemp(path.join(tmpdir(), "synara-icon-prune-"));
  temporaryRoots.push(root);
  const sourceFile = path.join(root, "source.tsx");
  await writeFile(sourceFile, source);
  for (const directory of CENTRAL_ICON_DIRS) {
    await mkdir(path.join(root, directory));
    for (const name of ["folder-2", "star", "robot", "unused"]) {
      await writeFile(
        path.join(root, directory, `${name}.svg`),
        `<svg id="${directory}-${name}"/>`,
      );
    }
    for (const suffix of ["gz", "br"]) {
      await writeFile(path.join(root, directory, `unused.svg.${suffix}`), "stale sidecar");
    }
  }
  return { root, sourceFile };
}

describe("Central icon production pruning", () => {
  it("prunes both sets while retaining either variant of every referenced name byte-for-byte", async () => {
    const { root, sourceFile } = await fixture('<CentralIcon name="robot" variant="fill" />');
    const counts = await pruneCentralIcons(root, [sourceFile]);
    expect(counts).toEqual(
      CENTRAL_ICON_DIRS.map((directory) => ({ directory, kept: 1, removed: 3 })),
    );
    for (const directory of CENTRAL_ICON_DIRS) {
      expect(await readdir(path.join(root, directory))).toEqual(["robot.svg"]);
      expect(await readFile(path.join(root, directory, "robot.svg"), "utf8")).toBe(
        `<svg id="${directory}-robot"/>`,
      );
    }
  });

  it("preserves .svg suffixes, static URLs, and shared-contract references", async () => {
    const { root, sourceFile } = await fixture(
      'getCentralIconUrl("folder-2.svg"); "/central-icons-fill/robot.svg";',
    );
    const sharedSource = path.join(root, "contracts.ts");
    await writeFile(sharedSource, 'export const icons = ["star"] as const;');
    await pruneCentralIcons(root, [sourceFile, sharedSource]);
    for (const directory of CENTRAL_ICON_DIRS) {
      expect((await readdir(path.join(root, directory))).sort()).toEqual([
        "folder-2.svg",
        "robot.svg",
        "star.svg",
      ]);
    }
  });

  it("keeps all assets if no references can be established", async () => {
    const { root, sourceFile } = await fixture("export const unrelated = 1;");
    expect(await pruneCentralIcons(root, [sourceFile])).toEqual([]);
    expect(await readdir(path.join(root, CENTRAL_ICON_DIRS[0]))).toHaveLength(6);
  });

  it("fails before deleting anything when a source file cannot be read", async () => {
    const { root, sourceFile } = await fixture('"robot"');
    await expect(
      pruneCentralIcons(root, [sourceFile, path.join(root, "missing.ts")]),
    ).rejects.toThrow();
    expect(await readdir(path.join(root, CENTRAL_ICON_DIRS[0]))).toHaveLength(6);
  });
});
