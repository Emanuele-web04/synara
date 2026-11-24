// FILE: transform-cache.ts
// Purpose: Persist one Vite plugin's transform results between CI runs.
// Layer: Web build config
// Depends on: Node crypto and filesystem.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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

// A claim directory holds an `owner` file naming the process that compiles the
// entry. Large modules can take minutes to compile on a loaded runner, so a
// waiter keeps waiting while that process lives. The cap only bounds a claim
// whose owner cannot be checked.
const CLAIM_OWNER_FILE = "owner";
const CLAIM_POLL_MS = 40;
const OWNERLESS_CLAIM_GRACE_MS = 2_000;
const CLAIM_WAIT_CAP_MS = 5 * 60_000;

type ClaimWait = "released" | "abandoned" | "expired";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function claimOwnerIsAlive(claimPath: string): Promise<boolean | undefined> {
  try {
    const owner: unknown = JSON.parse(
      await fs.promises.readFile(path.join(claimPath, CLAIM_OWNER_FILE), "utf8"),
    );
    const { pid, host } = owner as { pid?: unknown; host?: unknown };
    if (typeof pid !== "number" || host !== os.hostname()) return false;
    return processIsAlive(pid);
  } catch {
    // Not written yet, or the claim was just released.
    return undefined;
  }
}

async function waitForClaim(claimPath: string): Promise<ClaimWait> {
  const start = performance.now();
  while (performance.now() - start < CLAIM_WAIT_CAP_MS) {
    const alive = await claimOwnerIsAlive(claimPath);
    const exists = await fs.promises.access(claimPath).then(
      () => true,
      () => false,
    );
    if (!exists) return "released";
    if (alive === false) return "abandoned";
    // The owner writes its file right after creating the claim. A claim that
    // stays without one lost its process in between.
    if (alive === undefined && performance.now() - start > OWNERLESS_CLAIM_GRACE_MS) {
      return "abandoned";
    }
    await delay(CLAIM_POLL_MS);
  }
  return "expired";
}

// Only paired browser processes coordinate. A failed writer or unavailable
// directory falls back to an independent transform, and a claim whose owner
// is gone is taken over.
async function compileWithClaim(entryPath: string, compile: () => Promise<unknown>) {
  const claimPath = `${entryPath}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });
      await fs.promises.mkdir(claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return compile();
      const wait = await waitForClaim(claimPath);
      const shared = await readEntry(entryPath);
      if (shared) return shared;
      if (wait !== "abandoned") return compile();
      await fs.promises.rm(claimPath, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    try {
      await fs.promises
        .writeFile(
          path.join(claimPath, CLAIM_OWNER_FILE),
          JSON.stringify({ pid: process.pid, host: os.hostname() }),
        )
        .catch(() => undefined);
      // The other process may have published an entry before we took the claim.
      return (await readEntry(entryPath)) ?? (await compile());
    } finally {
      await fs.promises.rm(claimPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return compile();
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
