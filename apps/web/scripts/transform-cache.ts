// FILE: transform-cache.ts
// Purpose: Persist one Vite plugin's transform results between CI runs.
// Layer: Web build config
// Depends on: Node crypto and filesystem.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type TransformHandler = (
  this: unknown,
  code: string,
  id: string,
  options?: { moduleType?: string },
) => unknown;

interface CachedTransform {
  readonly code: string;
  readonly map?: unknown;
}

function isCachedTransform(value: unknown): value is CachedTransform {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

async function readEntry(entryPath: string): Promise<CachedTransform | undefined> {
  try {
    const cached: unknown = JSON.parse(await fs.promises.readFile(entryPath, "utf8"));
    return isCachedTransform(cached) ? cached : undefined;
  } catch {
    return undefined;
  }
}

// Only paired browser processes coordinate. A failed writer, unavailable
// directory or expired wait falls back to an independent transform.
async function compileWithClaim(entryPath: string, compile: () => Promise<unknown>) {
  const claimPath = `${entryPath}.lock`;
  try {
    await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.promises.mkdir(claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        if (
          !(await fs.promises.access(claimPath).then(
            () => true,
            () => false,
          ))
        )
          break;
        await delay(40);
      }
      const shared = await readEntry(entryPath);
      if (shared) return shared;
    }
    return compile();
  }
  try {
    // The other process may have published an entry before we took the claim.
    return (await readEntry(entryPath)) ?? (await compile());
  } finally {
    await fs.promises.rmdir(claimPath).catch(() => undefined);
  }
}

function environmentName(context: unknown): string {
  const name = (context as { environment?: { name?: unknown } } | undefined)?.environment?.name;
  return typeof name === "string" ? name : "";
}

/**
 * Wraps `plugin.transform` so an unchanged module reuses its previous output.
 *
 * The transform must be a pure function of its inputs. An entry is keyed by
 * `salt` (everything that changes the output without changing the module:
 * lockfile, plugin options), the Vite environment, the module type, the module
 * id and the exact input code. A changed module never matches an older entry,
 * and an unreadable or malformed entry is recomputed, never trusted.
 */
export function withTransformCache<T extends { readonly name: string; transform?: unknown }>(
  plugin: T,
  options: {
    readonly directory: string;
    readonly salt: string;
    readonly coordinateWrites?: boolean;
  },
): T {
  const hook = plugin.transform as { handler?: unknown } | null | undefined;
  if (typeof hook !== "object" || hook === null || typeof hook.handler !== "function") {
    throw new Error(`Plugin ${plugin.name} has no object transform hook to cache.`);
  }
  const handler = hook.handler as TransformHandler;
  let writeSequence = 0;

  const cachedHandler: TransformHandler = async function (code, id, hookOptions) {
    const key = createHash("sha256")
      .update(options.salt)
      .update("\0")
      .update(environmentName(this))
      .update("\0")
      .update(hookOptions?.moduleType ?? "")
      .update("\0")
      .update(id)
      .update("\0")
      .update(code)
      .digest("hex");
    const entryPath = path.join(options.directory, key.slice(0, 2), `${key}.json`);
    const cached = await readEntry(entryPath);
    if (cached) return cached;

    const compile = async () => {
      const result = await handler.call(this, code, id, hookOptions);
      // Only complete code results are stored; "no change" stays a cheap rerun.
      if (isCachedTransform(result)) {
        // Rename is atomic within a directory, so a concurrent reader sees
        // either no entry or the complete one. The staging name is unique per
        // write, so two transforms of one module cannot share a partial file.
        writeSequence += 1;
        const temporaryPath = `${entryPath}.${process.pid}.${writeSequence}.tmp`;
        try {
          await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });
          await fs.promises.writeFile(
            temporaryPath,
            JSON.stringify({ code: result.code, map: result.map ?? null }),
          );
          await fs.promises.rename(temporaryPath, entryPath);
        } catch {
          // The caller can use the compiled module even if disk caching fails.
          await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        }
      }
      return result;
    };
    return options.coordinateWrites ? compileWithClaim(entryPath, compile) : compile();
  };

  // The plugin mutates `transform.filter` on this same object after the config
  // resolves, so replace the handler in place instead of copying the hook.
  hook.handler = cachedHandler;
  return plugin;
}
