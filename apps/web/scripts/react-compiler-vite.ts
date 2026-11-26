// FILE: react-compiler-vite.ts
// Purpose: Configure the React Compiler transform, workers and cache for Vite.
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin, PluginOption } from "vite";
import { compilerCacheFingerprint } from "./compiler-cache-key";
import {
  threadWorkerFactory,
  transformWorkerCount,
  withParallelTransform,
} from "./parallel-transform";
import { createReactCompilerPlugin } from "./react-compiler-plugin.mjs";
import { withTransformCache } from "./transform-cache";

// Browser tests and the Desktop CI build opt into separate cache namespaces.
const testTransformCacheDirectory =
  process.env.VITEST === "true" ? process.env.SYNARA_WEB_TRANSFORM_CACHE_DIR?.trim() : undefined;

function transformCacheSalt(productionBuild: boolean, buildSourcemap: boolean | "hidden"): string {
  const hash = createHash("sha256").update(compilerCacheFingerprint()).update("\0");
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

export function createViteReactCompilerPlugin(
  buildSourcemap: boolean | "hidden",
): Promise<Awaited<PluginOption>> {
  return createReactCompilerPlugin().then((plugin) => {
    const workers = transformWorkerCount();
    const compiler =
      workers > 0
        ? withParallelTransform(plugin, {
            workers,
            createWorker: threadWorkerFactory(
              pathToFileURL(path.resolve(import.meta.dirname, "parallel-transform.worker.mjs")),
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
            directory: path.resolve(import.meta.dirname, "..", cacheDirectory),
            salt: transformCacheSalt(productionBuild, buildSourcemap),
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
  });
}
