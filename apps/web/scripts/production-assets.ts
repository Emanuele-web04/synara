import fs from "node:fs/promises";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
export const CENTRAL_ICON_DIRECTORIES = ["central-icons-reversed", "central-icons-fill"] as const;

export async function listFiles(root: string): Promise<string[]> {
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  const files: string[] = [];
  for (const entry of entries) {
    const name = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(name)));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}

export async function pruneProductionIcons(
  publicDirectory: string,
  outputDirectory: string,
  sourceRoots: readonly string[],
): Promise<void> {
  const required = new Set<string>();
  const literal = /["'`]([a-z0-9][a-z0-9-]*)(?:\.svg)?["'`]/g;
  for (const root of sourceRoots) {
    for (const file of await listFiles(root)) {
      if (!SOURCE_EXTENSIONS.has(path.extname(file))) continue;
      for (const match of (await fs.readFile(file, "utf8")).matchAll(literal)) {
        if (match[1]) required.add(match[1]);
      }
    }
  }
  for (const directory of CENTRAL_ICON_DIRECTORIES) {
    const publicFiles = await listFiles(path.join(publicDirectory, directory));
    const available = publicFiles
      .filter((file) => file.endsWith(".svg"))
      .map((file) => path.basename(file, ".svg"));
    const retained = new Set(available.filter((name) => required.has(name)));
    if (retained.size === 0) continue;
    let removed = 0;
    for (const name of available) {
      if (retained.has(name)) continue;
      await Promise.all(
        [".svg", ".svg.gz", ".svg.br"].map((suffix) =>
          fs.rm(path.join(outputDirectory, directory, `${name}${suffix}`), { force: true }),
        ),
      );
      removed += 1;
    }
    console.info(
      `[central-icons] ${directory}: retained ${retained.size}/${available.length}, pruned ${removed}.`,
    );
  }
}
