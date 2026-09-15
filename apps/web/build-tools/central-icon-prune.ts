// FILE: central-icon-prune.ts
// Purpose: Prune both Central icon variants without changing retained SVG bytes.
// Layer: Web build helper. Source assets and development serving stay untouched.
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

export const CENTRAL_ICON_DIRS = ["central-icons-reversed", "central-icons-fill"] as const;

export async function pruneCentralIcons(outDir: string, sourceFiles: readonly string[]) {
  const required = new Set<string>();
  for (const sourceFile of sourceFiles) {
    // Do not swallow read errors: an incomplete reference inventory must never
    // silently remove icons. Include shared contracts and suffixed/icon URL literals.
    const source = await readFile(sourceFile, "utf8");
    const literals =
      /["'`](?:\/central-icons-(?:reversed|fill)\/)?([a-z0-9][a-z0-9-]*)(?:\.svg)?["'`]/g;
    for (const match of source.matchAll(literals)) required.add(match[1]!);
  }
  const counts = [];
  for (const directory of CENTRAL_ICON_DIRS) {
    const iconDir = path.join(outDir, directory);
    const files = await readdir(iconDir);
    const svgFiles = files.filter((name) => name.endsWith(".svg"));
    const referenced = svgFiles.filter((name) => required.has(name.slice(0, -4)));
    // Fail conservatively if a future source layout yields no references.
    if (referenced.length === 0) continue;
    const unused = svgFiles.filter((name) => !required.has(name.slice(0, -4)));
    await Promise.all(
      unused.flatMap((name) =>
        [name, `${name}.gz`, `${name}.br`].map((file) =>
          rm(path.join(iconDir, file), { force: true }),
        ),
      ),
    );
    counts.push({ directory, kept: referenced.length, removed: unused.length });
  }
  return counts;
}
