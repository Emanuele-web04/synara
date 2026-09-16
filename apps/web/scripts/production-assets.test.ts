import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CENTRAL_ICON_DIRECTORIES, pruneProductionIcons } from "./production-assets";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "synara-icons-"));
  roots.push(root);
  const source = path.join(root, "src");
  const contracts = path.join(root, "contracts");
  const publicDir = path.join(root, "public");
  const dist = path.join(root, "dist");
  await fs.mkdir(source);
  await fs.mkdir(contracts);
  for (const dir of CENTRAL_ICON_DIRECTORIES) {
    await fs.mkdir(path.join(publicDir, dir), { recursive: true });
    await fs.mkdir(path.join(dist, dir), { recursive: true });
    for (const name of ["star", "cloud", "bag", "unused"]) {
      const svg = `<svg data-variant="${dir}" data-name="${name}"/>`;
      await fs.writeFile(path.join(publicDir, dir, `${name}.svg`), svg);
      await fs.writeFile(path.join(dist, dir, `${name}.svg`), svg);
    }
  }
  return { source, contracts, publicDir, dist };
}

describe("production icon pruning", () => {
  it("keeps both variants, shared persisted names, and .svg-suffixed literals byte-for-byte", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, "icons.tsx"), 'const icons = ["star", `cloud.svg`];');
    await fs.writeFile(path.join(f.contracts, "schema.ts"), 'const allowed = ["bag"];');
    for (const dir of CENTRAL_ICON_DIRECTORIES) {
      await fs.writeFile(path.join(f.dist, dir, "unused.svg.gz"), "old gzip");
      await fs.writeFile(path.join(f.dist, dir, "unused.svg.br"), "old brotli");
    }
    await pruneProductionIcons(f.publicDir, f.dist, [f.source, f.contracts]);
    for (const dir of CENTRAL_ICON_DIRECTORIES) {
      expect((await fs.readdir(path.join(f.dist, dir))).sort()).toEqual([
        "bag.svg",
        "cloud.svg",
        "star.svg",
      ]);
      for (const name of ["bag", "cloud", "star"]) {
        expect(await fs.readFile(path.join(f.dist, dir, `${name}.svg`))).toEqual(
          await fs.readFile(path.join(f.publicDir, dir, `${name}.svg`)),
        );
      }
    }
    // A repeated/watch pass is safe even though unused outputs are already gone.
    await pruneProductionIcons(f.publicDir, f.dist, [f.source, f.contracts]);
  });

  it("does not delete an icon set when no references are discoverable", async () => {
    const f = await fixture();
    await pruneProductionIcons(f.publicDir, f.dist, [f.source]);
    for (const dir of CENTRAL_ICON_DIRECTORIES) {
      expect(await fs.readdir(path.join(f.dist, dir))).toHaveLength(4);
    }
  });
});
