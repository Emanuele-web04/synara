// Production build of apps/web with one chunking variant from variants.mjs, written to
// its own directory so several variants of one checkout can be served side by side.
//
//   node benchmarks/web-boot/build-variant.mjs --variant V2 --out <dir> [--repo <checkout>]
//
// Everything except `build.rolldownOptions.output.codeSplitting` comes from the
// checkout's apps/web/vite.config.ts; `--variant asis` keeps that too (use it for `main`
// or for the config as committed). Set SYNARA_WEB_BUILD_TRANSFORM_CACHE_DIR to reuse
// React Compiler output between variants; it only caches identical inputs.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { variantPlugins, variants } from "./variants.mjs";

const { values } = parseArgs({
  options: {
    variant: { type: "string" },
    out: { type: "string" },
    repo: { type: "string", default: path.resolve(import.meta.dirname, "../..") },
    // Optional JSON with every chunk's file, imports and modules (rendered bytes).
    report: { type: "string" },
  },
});
const asis = values.variant === "asis";
if (!values.variant || !(asis || values.variant in variants) || !values.out) {
  console.error(
    `usage: --variant <asis|${Object.keys(variants).join("|")}> --out <dir> [--repo <dir>] [--report <file>]`,
  );
  process.exit(2);
}
const webRoot = path.join(path.resolve(values.repo), "apps/web");
const outDir = path.resolve(values.out);
const report = values.report && path.resolve(values.report);
// Babel resolves the React Compiler plugin from the working directory, as in `bun run build`.
process.chdir(webRoot);
const { build } = await import(
  pathToFileURL(path.join(webRoot, "node_modules/vite/dist/node/index.js")).href
);
const codeSplitting = variants[values.variant];

await build({
  root: webRoot,
  configFile: path.join(webRoot, "vite.config.ts"),
  mode: "production",
  build: { outDir, emptyOutDir: true },
  plugins: [
    {
      name: "web-boot-variant",
      enforce: "post",
      config(config) {
        if (asis) return;
        const output = config.build?.rolldownOptions?.output;
        if (!output || Array.isArray(output)) throw new Error("unexpected rolldownOptions.output");
        if (codeSplitting === undefined) delete output.codeSplitting;
        else output.codeSplitting = codeSplitting;
      },
      buildStart() {
        console.info(`[web-boot] variant ${values.variant}, rolldown ${this.meta.rolldownVersion}`);
      },
      async generateBundle(_options, bundle) {
        if (!report) return;
        const chunks = Object.values(bundle)
          .filter((item) => item.type === "chunk")
          .map((chunk) => ({
            fileName: chunk.fileName,
            name: chunk.name,
            isEntry: chunk.isEntry,
            isDynamicEntry: chunk.isDynamicEntry,
            facadeModuleId: chunk.facadeModuleId,
            imports: chunk.imports,
            dynamicImports: chunk.dynamicImports,
            modules: Object.fromEntries(
              Object.entries(chunk.modules).map(([id, info]) => [id, info.renderedLength]),
            ),
          }));
        const { writeFile } = await import("node:fs/promises");
        await writeFile(report, JSON.stringify(chunks));
      },
    },
    ...(variantPlugins[values.variant] ?? []),
  ],
});
