// FILE: transform-cache.ts
// Purpose: Persist one Vite plugin's transform results on disk between test runs.
// Layer: Web build config (test lanes only; production builds never enable it)
// Depends on: Node crypto and filesystem.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  options: { readonly directory: string; readonly salt: string },
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
    try {
      const cached: unknown = JSON.parse(await fs.promises.readFile(entryPath, "utf8"));
      if (isCachedTransform(cached)) return cached;
    } catch {
      // A missing or unreadable entry is a miss.
    }
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
        // The browser lane can use the compiled module even if disk caching fails.
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    }
    return result;
  };

  // The plugin mutates `transform.filter` on this same object after the config
  // resolves, so replace the handler in place instead of copying the hook.
  hook.handler = cachedHandler;
  return plugin;
}
