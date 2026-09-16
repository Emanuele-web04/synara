// FILE: public-assets.ts
// Purpose: Prune only unused build-output assets, leaving source artwork intact.
// Layer: Web build helpers

import fs from "node:fs/promises";
import path from "node:path";

export const CENTRAL_ICON_DIRECTORIES = ["central-icons-reversed", "central-icons-fill"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".css"]);

export async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(entryPath)));
    else if (entry.isFile()) result.push(entryPath);
  }
  return result;
}

// Keep a conservative superset in BOTH variants: callers can select a variant
// dynamically. Include mapping tables, test fixtures, suffixed names and URLs.
export function collectCentralIconNames(sources: ReadonlyArray<string>): Set<string> {
  const names = new Set<string>();
  const literal =
    /["'`](?:\/central-icons-(?:reversed|fill)\/)?([a-z0-9][a-z0-9-]*)(?:\.svg)?["'`]/g;
  for (const source of sources) {
    for (const match of source.matchAll(literal)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return names;
}

async function optionalDirectory(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function pruneProductionPublicAssets(root: string, outDir: string): Promise<void> {
  const sourceFiles = (await listFiles(path.join(root, "src"))).filter((file) =>
    SOURCE_EXTENSIONS.has(path.extname(file)),
  );
  // A read failure must fail the build, not silently delete an icon's only use.
  const names = collectCentralIconNames(
    await Promise.all(sourceFiles.map((file) => fs.readFile(file, "utf8"))),
  );
  for (const directory of CENTRAL_ICON_DIRECTORIES) {
    const available = (await optionalDirectory(path.join(root, "public", directory))).filter(
      (name) => name.endsWith(".svg"),
    );
    const required = new Set(available.filter((name) => names.has(name.slice(0, -4))));
    // Fail open when the source scan cannot identify any used icons in a set.
    if (required.size === 0) continue;
    const copied = await optionalDirectory(path.join(outDir, directory));
    let removed = 0;
    for (const name of copied) {
      const original = name.replace(/\.(?:gz|br)$/, "");
      if (!original.endsWith(".svg") || required.has(original)) continue;
      await fs.rm(path.join(outDir, directory, name), { force: true });
      if (name === original) removed += 1;
    }
    console.info(
      `[central-icons] ${directory}: kept ${required.size}/${available.length}, pruned ${removed}.`,
    );
  }
  // MSW is used by browser tests, never by the production application. Keep
  // public/mockServiceWorker.js for dev/tests; remove only its copied output.
  await Promise.all(
    ["", ".gz", ".br"].map((suffix) =>
      fs.rm(path.join(outDir, `mockServiceWorker.js${suffix}`), { force: true }),
    ),
  );
}
