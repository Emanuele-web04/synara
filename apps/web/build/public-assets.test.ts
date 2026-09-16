import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CENTRAL_ICON_DIRECTORIES,
  pruneProductionPublicAssets,
  referencedCentralIcons,
} from "./public-assets";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source: string) {
  const root = await mkdtemp(path.join(tmpdir(), "synara-public-assets-"));
  fixtures.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "icons.ts"), source);
  await writeFile(path.join(root, "index.html"), "<html></html>");
  for (const directory of CENTRAL_ICON_DIRECTORIES) {
    const dir = path.join(root, "public", directory);
    await mkdir(dir, { recursive: true });
    for (const name of ["sun", "moon", "unused"]) {
      await writeFile(path.join(dir, `${name}.svg`), `<svg data-icon="${name}"/>`);
    }
  }
  await writeFile(path.join(root, "public", "mockServiceWorker.js"), "development worker");
  const out = path.join(root, "dist");
  await cp(path.join(root, "public"), out, { recursive: true });
  return { root, out };
}

describe("production public assets", () => {
  it("recognizes literal tables, svg suffixes and CSS/direct URLs conservatively", () => {
    const available = new Set(["sun", "moon", "folder", "unused"]);
    expect(
      [
        ...referencedCentralIcons(
          `const names = ["sun", 'moon.svg']; url(/central-icons-fill/folder.svg)`,
          available,
        ),
      ].sort(),
    ).toEqual(["folder", "moon", "sun"]);
    expect([...referencedCentralIcons('"not-an-icon"', available)]).toEqual([]);
  });

  it("keeps referenced SVG bytes in both variants and removes unused SVG sidecars", async () => {
    const { root, out } = await fixture('const preferenceIcons = ["sun", "moon.svg"];');
    for (const directory of CENTRAL_ICON_DIRECTORIES) {
      await writeFile(path.join(out, directory, "unused.svg.gz"), "stale");
      await writeFile(path.join(out, directory, "unused.svg.br"), "stale");
    }
    await pruneProductionPublicAssets(root, out);
    for (const directory of CENTRAL_ICON_DIRECTORIES) {
      expect((await readdir(path.join(out, directory))).sort()).toEqual(["moon.svg", "sun.svg"]);
      for (const name of ["sun", "moon"]) {
        expect(await readFile(path.join(out, directory, `${name}.svg`))).toEqual(
          await readFile(path.join(root, "public", directory, `${name}.svg`)),
        );
      }
      expect(await readdir(path.join(root, "public", directory))).toHaveLength(3);
    }
  });

  it("retains the library when a scan finds no names", async () => {
    const { root, out } = await fixture("export const other = 42;");
    await pruneProductionPublicAssets(root, out);
    for (const directory of CENTRAL_ICON_DIRECTORIES) {
      expect(await readdir(path.join(out, directory))).toHaveLength(3);
    }
  });

  it("removes only the production MSW worker and its stale sidecars", async () => {
    const { root, out } = await fixture('const icon = "sun";');
    for (const suffix of [".gz", ".br"])
      await writeFile(path.join(out, `mockServiceWorker.js${suffix}`), "stale");
    await writeFile(path.join(out, "runtime-worker.js"), "keep");
    await pruneProductionPublicAssets(root, out);
    expect((await readdir(out)).filter((name) => name.startsWith("mockServiceWorker"))).toEqual([]);
    expect(await readFile(path.join(root, "public", "mockServiceWorker.js"), "utf8")).toBe(
      "development worker",
    );
    expect(await readFile(path.join(out, "runtime-worker.js"), "utf8")).toBe("keep");
  });

  it("fails before pruning when a source scan cannot complete", async () => {
    const { root, out } = await fixture('const icon = "sun";');
    await rm(path.join(root, "src"), { recursive: true });
    await expect(pruneProductionPublicAssets(root, out)).rejects.toThrow();
    expect(await readdir(path.join(out, "central-icons-fill"))).toHaveLength(3);
  });
});
