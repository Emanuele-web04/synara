// Build-only public asset pruning. Runtime rendering and the development public tree stay intact.
import fs from "node:fs/promises";
import path from "node:path";

export const CENTRAL_ICON_DIRECTORIES = ["central-icons-reversed", "central-icons-fill"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".json"]);

export async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(entryPath)));
    else if (entry.isFile()) result.push(entryPath);
  }
  return result;
}

export function referencedCentralIcons(
  source: string,
  available: ReadonlySet<string>,
): Set<string> {
  const required = new Set<string>();
  // Keep either variant for every literal basename, including mapping tables,
  // suffixed names and direct asset URLs. Comments/tests intentionally over-retain.
  const patterns = [
    /["'`]([a-z0-9][a-z0-9-]*)(?:\.svg)?["'`]/g,
    /\/central-icons-(?:reversed|fill)\/([a-z0-9][a-z0-9-]*)\.svg/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name && available.has(name)) required.add(name);
    }
  }
  return required;
}

export async function pruneProductionPublicAssets(
  root: string,
  outDir: string,
  additionalSourceRoots: ReadonlyArray<string> = [],
): Promise<void> {
  const available = new Set<string>();
  for (const directory of CENTRAL_ICON_DIRECTORIES) {
    for (const name of await fs.readdir(path.join(root, "public", directory))) {
      if (name.endsWith(".svg")) available.add(name.slice(0, -4));
    }
  }
  const required = new Set<string>();
  const sources: string[] = [path.join(root, "index.html")];
  for (const sourceRoot of [path.join(root, "src"), ...additionalSourceRoots]) {
    sources.push(
      ...(await listFiles(sourceRoot)).filter((file) => SOURCE_EXTENSIONS.has(path.extname(file))),
    );
  }
  for (const file of sources) {
    for (const name of referencedCentralIcons(await fs.readFile(file, "utf8"), available)) {
      required.add(name);
    }
  }
  // An empty scan is not permission to delete the entire icon library.
  if (required.size > 0) {
    let removed = 0;
    for (const directory of CENTRAL_ICON_DIRECTORIES) {
      const destination = path.join(outDir, directory);
      for (const file of await fs.readdir(destination)) {
        const match = /^(.+)\.svg(?:\.(?:gz|br))?$/.exec(file);
        if (!match?.[1] || required.has(match[1])) continue;
        await fs.rm(path.join(destination, file));
        removed += 1;
      }
    }
    console.info(
      `[central-icons] kept ${required.size} referenced names in both variants; pruned ${removed} files.`,
    );
  }
  // MSW is used only by development/browser tests, never the production client.
  for (const suffix of ["", ".gz", ".br"]) {
    await fs.rm(path.join(outDir, `mockServiceWorker.js${suffix}`), { force: true });
  }
}
