import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CENTRAL_ICON_DIRECTORIES,
  collectCentralIconNames,
  pruneProductionPublicAssets,
} from "./public-assets";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "synara-public-assets-"));
  roots.push(root);
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(path.join(root, "src", "nested", "icons.tsx"), source);
  for (const directory of CENTRAL_ICON_DIRECTORIES) {
    for (const parent of ["public", "dist"]) {
      await mkdir(path.join(root, parent, directory), { recursive: true });
      for (const name of ["keep.svg", "unused.svg", "suffixed.svg", "direct.svg"]) {
        await writeFile(path.join(root, parent, directory, name), `<svg id="${name}"/>`);
      }
    }
    await writeFile(path.join(root, "dist", directory, "unused.svg.br"), "stale");
    await writeFile(path.join(root, "dist", directory, "unused.svg.gz"), "stale");
    await writeFile(path.join(root, "dist", directory, "LICENSE"), "license");
  }
  for (const parent of ["public", "dist"]) {
    await writeFile(path.join(root, parent, "mockServiceWorker.js"), "test worker");
  }
  return root;
}

describe("production public assets", () => {
  it("recognizes mapping literals, suffixed names and direct URLs", () => {
    const names = collectCentralIconNames([
      '<Icon name="keep" variant={variant}/>',
      "const icons = ['mapped', `template`, 'suffixed.svg', '/central-icons-fill/direct.svg'];",
    ]);
    for (const name of ["keep", "mapped", "template", "suffixed", "direct"]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("prunes both variants and stale sidecars without changing retained SVGs or sources", async () => {
    const root = await fixture(
      'const icons = ["keep", "suffixed.svg", "/central-icons-fill/direct.svg"];',
    );
    await pruneProductionPublicAssets(root, path.join(root, "dist"));
    for (const directory of CENTRAL_ICON_DIRECTORIES) {
      expect((await readdir(path.join(root, "dist", directory))).sort()).toEqual([
        "LICENSE",
        "direct.svg",
        "keep.svg",
        "suffixed.svg",
      ]);
      expect(await readFile(path.join(root, "dist", directory, "keep.svg"))).toEqual(
        await readFile(path.join(root, "public", directory, "keep.svg")),
      );
      expect(
        await readFile(path.join(root, "public", directory, "unused.svg"), "utf8"),
      ).toContain("unused.svg");
    }
    expect(await readdir(path.join(root, "dist"))).not.toContain("mockServiceWorker.js");
    expect(await readFile(path.join(root, "public", "mockServiceWorker.js"), "utf8")).toBe(
      "test worker",
    );
  });

  it("keeps an icon set when no references can be identified", async () => {
    const root = await fixture("export const empty = true;");
    await pruneProductionPublicAssets(root, path.join(root, "dist"));
    for (const directory of CENTRAL_ICON_DIRECTORIES) {
      expect(await readdir(path.join(root, "dist", directory))).toContain("unused.svg");
    }
  });

  it("fails closed on unreadable source rather than dropping its icons", async () => {
    const root = await fixture('const icon = "keep";');
    await rm(path.join(root, "src"), { recursive: true });
    await expect(pruneProductionPublicAssets(root, path.join(root, "dist"))).rejects.toThrow();
    expect(await readdir(path.join(root, "dist", "central-icons-fill"))).toContain("keep.svg");
  });
});
