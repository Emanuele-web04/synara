import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BACKEND_COMPILE_CACHE_ENV,
  backendCompileCacheEnv,
  pruneBackendCompileCaches,
  resolveBackendCompileCacheDir,
} from "./backendCompileCache";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("backend compile cache", () => {
  it("keeps one directory per app version under the data home's state dir", () => {
    expect(resolveBackendCompileCacheDir("/home/.synara-beta/userdata", "1.6.0-beta.2")).toBe(
      "/home/.synara-beta/userdata/cache/backend-compile/1.6.0-beta.2",
    );
    expect(resolveBackendCompileCacheDir("/home/.synara/userdata", "1.5.4 / dev")).toBe(
      "/home/.synara/userdata/cache/backend-compile/1.5.4-dev",
    );
  });

  it("enables the cache for the backend only when the user has not configured one", () => {
    expect(backendCompileCacheEnv({}, "/cache/1.5.4")).toEqual({
      NODE_COMPILE_CACHE: "/cache/1.5.4",
      [BACKEND_COMPILE_CACHE_ENV]: "/cache/1.5.4",
    });
    expect(
      backendCompileCacheEnv(
        { NODE_COMPILE_CACHE: "/users/own", [BACKEND_COMPILE_CACHE_ENV]: "/users/own" },
        "/cache/1.5.4",
      ),
    ).toEqual({ [BACKEND_COMPILE_CACHE_ENV]: undefined });
  });

  it("removes other versions' caches and keeps the current one", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "synara-compile-cache-"));
    tempDirs.push(stateDir);
    const current = resolveBackendCompileCacheDir(stateDir, "1.5.4");
    const previous = resolveBackendCompileCacheDir(stateDir, "1.5.3");
    await mkdir(join(current, "v24"), { recursive: true });
    await mkdir(join(previous, "v24"), { recursive: true });
    await writeFile(join(previous, "v24", "entry"), "cache");

    await pruneBackendCompileCaches(current);

    expect(await readdir(join(stateDir, "cache", "backend-compile"))).toEqual(["1.5.4"]);
    await expect(pruneBackendCompileCaches(join(stateDir, "missing", "1.5.4"))).resolves.toBe(
      undefined,
    );
  });
});
