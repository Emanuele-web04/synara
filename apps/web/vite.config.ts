// FILE: vite.config.ts
// Purpose: Builds the Synara web client and controls diagnostic source maps.
// Layer: Web build config
// Depends on: Vite, Tailwind, React compiler, TanStack Router.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { promisify } from "node:util";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json" with { type: "json" };
import { compilerCacheFingerprint } from "./scripts/compiler-cache-key";
import {
  threadWorkerFactory,
  transformWorkerCount,
  withParallelTransform,
} from "./scripts/parallel-transform";
import { listFiles, pruneProductionIcons } from "./scripts/production-assets";
import { createReactCompilerPlugin } from "./scripts/react-compiler-plugin.mjs";
import { withTransformCache } from "./scripts/transform-cache";

const port = Number(process.env.PORT ?? 5733);
const sourcemapEnv = process.env.SYNARA_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "1" || sourcemapEnv === "true"
    ? true
    : sourcemapEnv === "hidden"
      ? "hidden"
      : false;

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

// Browser tests and the Desktop CI build opt into separate cache namespaces.
const testTransformCacheDirectory =
  process.env.VITEST === "true" ? process.env.SYNARA_WEB_TRANSFORM_CACHE_DIR?.trim() : undefined;

function transformCacheSalt(productionBuild: boolean): string {
  const hash = createHash("sha256")
    .update(compilerCacheFingerprint(path.resolve(import.meta.dirname, "../..")))
    .update("\0");
  hash.update(`${process.env.BABEL_ENV ?? ""}\0${process.env.NODE_ENV ?? ""}\0`);
  if (productionBuild) {
    hash.update(
      JSON.stringify([
        "desktop-production",
        buildSourcemap,
        process.env.BROWSERSLIST,
        process.env.BROWSERSLIST_ENV,
      ]),
    );
  }
  return hash.digest("hex");
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

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    // React Compiler is a single-threaded Babel pass and nearly all of a
    // production build's time (.github/CI.md). Worker threads run the same
    // plugin's own hook. Opt-in CI caches only reuse identical inputs.
    createReactCompilerPlugin().then((plugin) => {
      const workers = transformWorkerCount();
      const compiler =
        workers > 0
          ? withParallelTransform(plugin, {
              workers,
              createWorker: threadWorkerFactory(
                pathToFileURL(
                  path.resolve(import.meta.dirname, "scripts/parallel-transform.worker.mjs"),
                ),
              ),
            })
          : plugin;
      let cacheWrapped = false;
      return {
        ...compiler,
        // Large chat modules make the compiler expensive on cold loads and every
        // edit. Oxc still provides JSX/TypeScript transforms and Fast Refresh.
        // Keep production builds and browser tests compiled, with an opt-in for
        // debugging compiler-specific behavior in the development app.
        apply: ((_config, { command, mode }) => {
          const productionBuild = command === "build" && mode === "production";
          const cacheDirectory = productionBuild
            ? process.env.SYNARA_WEB_BUILD_TRANSFORM_CACHE_DIR?.trim()
            : mode === "test"
              ? testTransformCacheDirectory
              : undefined;
          if (cacheDirectory && !cacheWrapped) {
            withTransformCache(compiler, {
              directory: path.resolve(import.meta.dirname, cacheDirectory),
              salt: transformCacheSalt(productionBuild),
              coordinateWrites:
                !productionBuild && process.env.SYNARA_WEB_TRANSFORM_CACHE_SHARED === "true",
            });
            cacheWrapped = true;
          }
          return (
            command === "build" ||
            mode === "test" ||
            /^(1|true)$/i.test(process.env.SYNARA_DEV_REACT_COMPILER?.trim() ?? "")
          );
        }) satisfies Plugin["apply"],
      };
    }),
    tailwindcss(),
    centralIconPrunePlugin(),
    precompressPlugin(),
  ],
  optimizeDeps: {
    include: [
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@pierre/diffs/worker/worker.js",
      "react-icons/gr",
    ],
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
    // The largest chunks are intentionally lazy-loaded editor grammars,
    // terminal runtime code, and the chat route—not initial-load bundles.
    chunkSizeWarningLimit: 850,
    rolldownOptions: {
      checks: {
        // React Compiler is expected to dominate transform time in this app.
        pluginTimings: false,
      },
    },
  },
});
