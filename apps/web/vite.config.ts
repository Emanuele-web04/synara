// FILE: vite.config.ts
// Purpose: Builds the Synara web client and controls diagnostic source maps.
// Layer: Web build config
// Depends on: Vite, Tailwind, React compiler, TanStack Router.

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json" with { type: "json" };
import { bootChunkGroups } from "./scripts/boot-chunk-groups";
import { listFiles, pruneProductionIcons } from "./scripts/production-assets";
import { createViteReactCompilerPlugin } from "./scripts/react-compiler-vite";

const port = Number(process.env.PORT ?? 5733);
const sourcemapEnv = process.env.SYNARA_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "1" || sourcemapEnv === "true"
    ? true
    : sourcemapEnv === "hidden"
      ? "hidden"
      : false;

const USED_SHIKI_THEMES = new Set(["github-light", "github-dark"]);
const PRUNED_SHIKI_THEME_ID = "\0synara-pruned-shiki-theme";

// Synara renders all code/diff highlighting via DIFF_THEME_NAMES (github-light,
// github-dark) and @pierre/theme defaults (pierre-light/pierre-dark). Stub out
// the other 60+ Shiki theme chunks that @pierre/theming and shiki reference
// behind dynamic imports so they are not emitted into dist/assets.
function pruneUnusedShikiThemesPlugin(): Plugin {
  return {
    name: "synara-prune-unused-shiki-themes",
    apply: "build",
    enforce: "pre",
    resolveId: {
      filter: { id: /^(?:@shikijs\/themes|shiki\/themes)\// },
      handler(source) {
        const match = /^(?:@shikijs\/themes|shiki\/themes)\/([^/]+)$/.exec(source);
        if (match?.[1] && !USED_SHIKI_THEMES.has(match[1])) {
          return PRUNED_SHIKI_THEME_ID;
        }
        return null;
      },
    },
    load: {
      filter: { id: /^\0synara-pruned-shiki-theme$/ },
      handler() {
        return "export default undefined;";
      },
    },
  };
}

// Electron Chromium and all supported browsers load woff2 natively; strip
// legacy woff and truetype fallbacks from KaTeX CSS so Vite does not emit
// 40 unused .woff/.ttf font files (~0.8 MB).
function katexWoff2OnlyPlugin(): Plugin {
  return {
    name: "synara-katex-woff2-only",
    apply: "build",
    enforce: "pre",
    transform: {
      filter: { id: /katex(?:\.min)?\.css/ },
      handler(code, id) {
        const normalized = id.replaceAll("\\", "/").split("?")[0] ?? "";
        if (!/\/katex\/dist\/katex(?:\.min)?\.css$/.test(normalized)) {
          return null;
        }
        const next = code.replace(
          /,url\(fonts\/KaTeX_[^)]+\.woff\)\s*format\("woff"\),url\(fonts\/KaTeX_[^)]+\.ttf\)\s*format\("truetype"\)/g,
          "",
        );
        return next === code ? null : { code: next, map: null };
      },
    },
  };
}

// Prune before compression. closeBundle hooks are parallel by default;
// enforce: "post" alone does not make the asynchronous compression hook wait.
function centralIconPrunePlugin(): Plugin {
  let resolvedRoot = process.cwd();
  let resolvedOutDir = "dist";
  return {
    name: "synara-central-icon-prune",
    apply: "build",
    configResolved(config) {
      resolvedRoot = config.root;
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "pre",
      sequential: true,
      async handler() {
        await pruneProductionIcons(path.join(resolvedRoot, "public"), resolvedOutDir, [
          path.join(resolvedRoot, "src"),
          path.resolve(resolvedRoot, "../../packages/contracts/src"),
          path.resolve(resolvedRoot, "../../packages/shared/src"),
        ]);
        // MSW is used by the dev-served browser tests, never the production app.
        await Promise.all(
          ["", ".gz", ".br"].map((suffix) =>
            fs.rm(path.join(resolvedOutDir, `mockServiceWorker.js${suffix}`), { force: true }),
          ),
        );
      },
    },
  };
}

const gzip = promisify(zlib.gzip);
const brotliCompress = promisify(zlib.brotliCompress);

const PRECOMPRESS_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".map"]);
// Below this size, compression savings don't beat the extra header bytes and
// the sidecar file overhead.
const PRECOMPRESS_MIN_BYTES = 1024;

// Emits .gz and .br sidecars next to compressible build outputs so the server
// can serve precompressed bytes by Accept-Encoding instead of compressing on
// the request path (apps/server/src/http.ts static route).
function precompressPlugin(): Plugin {
  let resolvedOutDir = "dist";
  return {
    name: "synara-precompress",
    apply: "build",
    // Run after central-icon pruning so removed files don't get sidecars.
    enforce: "post",
    configResolved(config) {
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files = (await listFiles(resolvedOutDir)).filter((file) =>
        PRECOMPRESS_EXTENSIONS.has(path.extname(file)),
      );
      // A sidecar whose source shrank below threshold or stopped compressing
      // smaller must be removed, not just skipped: emptyOutDir protects full
      // builds, but partial/watch builds would otherwise serve a stale
      // compressed body under a current filename.
      const removeStale = (sidecarPath: string) => fs.rm(sidecarPath, { force: true });
      // Write to a temp file and rename: a watch-build server reading a
      // sidecar mid-write would otherwise get a truncated compressed stream.
      // Rename is atomic within a directory, so readers see either the old
      // sidecar or the complete new one.
      let tempSequence = 0;
      const writeSidecarAtomically = async (sidecarPath: string, data: Buffer) => {
        // Unique per write so concurrent builds against one outDir cannot
        // clobber each other's staging file.
        tempSequence += 1;
        const tempPath = `${sidecarPath}.${process.pid}.${tempSequence}.tmp`;
        await fs.writeFile(tempPath, data);
        await fs.rename(tempPath, sidecarPath);
      };
      let sidecarCount = 0;
      await Promise.all(
        files.map(async (file) => {
          const source = await fs.readFile(file);
          if (source.byteLength < PRECOMPRESS_MIN_BYTES) {
            await Promise.all([removeStale(`${file}.gz`), removeStale(`${file}.br`)]);
            return;
          }
          // Max-quality brotli on thousands of small files dominates plugin
          // wall-clock; below 16 KiB quality 9 is byte-for-byte competitive.
          const brotliQuality =
            source.byteLength < 16 * 1024 ? 9 : zlib.constants.BROTLI_MAX_QUALITY;
          const [gzipped, brotlied] = await Promise.all([
            gzip(source, { level: zlib.constants.Z_BEST_COMPRESSION }),
            brotliCompress(source, {
              params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
              },
            }),
          ]);
          await Promise.all([
            gzipped.byteLength < source.byteLength
              ? writeSidecarAtomically(`${file}.gz`, gzipped)
              : removeStale(`${file}.gz`),
            brotlied.byteLength < source.byteLength
              ? writeSidecarAtomically(`${file}.br`, brotlied)
              : removeStale(`${file}.br`),
          ]);
          sidecarCount += 1;
        }),
      );
      console.info(`[precompress] emitted gzip+brotli sidecars for ${sidecarCount} files.`);
    },
  };
}

// Cold-boot steps after the entry, in load order: bootstrap.ts imports main.tsx once
// connected, every route renders inside the _chat layout, and usePreloadRouteChunks
// warms the thread route. The build fails if a root leaves the module graph, so a
// rename cannot silently drop a step.
const BOOT_STEPS = [
  { name: "boot-main", root: "src/main.tsx" },
  { name: "boot-chat", root: "src/routes/_chat.tsx?tsr-split=component" },
  { name: "boot-thread", root: "src/routes/_chat.$threadId.tsx?tsr-split=component" },
] as const;

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    createViteReactCompilerPlugin(buildSourcemap),
    tailwindcss(),
    katexWoff2OnlyPlugin(),
    pruneUnusedShikiThemesPlugin(),
    centralIconPrunePlugin(),
    precompressPlugin(),
  ],
  worker: {
    plugins: () => [pruneUnusedShikiThemesPlugin()],
  },
  optimizeDeps: {
    include: ["@pierre/diffs", "@pierre/diffs/react", "@pierre/diffs/worker/worker.js"],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL ?? ""),
    "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port,
    strictPort: true,
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host: "localhost",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
    // Above the limit: the lazy Monaco editor and CSS worker.
    chunkSizeWarningLimit: 850,
    rolldownOptions: {
      checks: {
        // React Compiler is expected to dominate transform time in this app.
        pluginTimings: false,
      },
      output: {
        // Automatic chunking spreads a cold boot over ~300 small shared chunks, one
        // per mix of lazy routes and components that also use a module; over HTTP/1.1
        // they queue on six connections. These groups load it in about 30 files
        // without growing what the entry evaluates before DOMContentLoaded:
        // - The entry's static closure (rolldown's `$initial` tag) goes first, in three
        //   chunks that download and compile in parallel. A broader group that took
        //   one of these modules would make the entry import, and evaluate, the rest
        //   of that group. Dependencies first: the last group holds the entry module,
        //   and a group takes its modules' dependencies with it.
        // - Each boot step is cut into acyclic bands of about 1 MB of source
        //   (bootChunkGroups). One file per step would be fewer requests, but on a
        //   slow CPU a 2 MB script adds a long main-thread task when it arrives.
        // Everything else (other routes, dialogs, xterm, KaTeX, @pierre/diffs,
        // locales) keeps automatic chunking and loads only when used.
        // Measurements: benchmarks/web-boot/RESULTS.md.
        codeSplitting: {
          groups: [
            {
              name: "boot-vendor",
              tags: ["$initial"],
              test: /[\\/]node_modules[\\/]/,
              priority: 1003,
            },
            {
              name: "boot-shared",
              tags: ["$initial"],
              test: /[\\/]packages[\\/]/,
              priority: 1002,
            },
            { name: "boot", tags: ["$initial"], priority: 1001 },
            ...bootChunkGroups({
              root: import.meta.dirname,
              entry: "src/bootstrap.ts",
              steps: BOOT_STEPS,
              bandBytes: 1_000_000,
              maxBandsPerStep: 40,
              priority: 1000,
            }),
          ],
        },
      },
    },
  },
});
