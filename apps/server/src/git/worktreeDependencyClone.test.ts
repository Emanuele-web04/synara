import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cloneDirectoriesWithClonefile,
  cloneWorktreeDependencies,
  type CloneDirectories,
  planDependencyClones,
} from "./worktreeDependencyClone.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function makeCheckouts() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-dependency-clone-"));
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "source");
  const worktreeRoot = path.join(root, "worktree");
  await fs.mkdir(sourceRoot);
  await fs.mkdir(worktreeRoot);
  return { sourceRoot, worktreeRoot };
}

async function writeFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

async function writeToBoth(roots: { sourceRoot: string; worktreeRoot: string }, file: string) {
  await writeFile(path.join(roots.sourceRoot, file), `contents of ${file}\n`);
  await writeFile(path.join(roots.worktreeRoot, file), `contents of ${file}\n`);
}

// Stands in for clonefile: a recursive copy has the same observable result.
const copyDirectories: CloneDirectories = async (pairs) => {
  await Promise.all(pairs.map((pair) => fs.cp(pair.source, pair.target, { recursive: true })));
  return pairs.map(() => true);
};

describe("planDependencyClones", () => {
  it("skips a checkout without a tracked lockfile", async () => {
    const roots = await makeCheckouts();
    await writeToBoth(roots, "package.json");
    await writeFile(path.join(roots.sourceRoot, "node_modules/a/index.js"), "a\n");

    expect(await planDependencyClones({ ...roots, trackedPaths: ["package.json"] })).toEqual({
      kind: "skip",
      reason: "no-lockfile",
    });
  });

  it("skips when any tracked lockfile differs or is missing from the source", async () => {
    const roots = await makeCheckouts();
    await writeToBoth(roots, "package.json");
    await writeToBoth(roots, "bun.lock");
    await writeFile(path.join(roots.worktreeRoot, "apps/web/package-lock.json"), "branch\n");
    await writeFile(path.join(roots.sourceRoot, "node_modules/a/index.js"), "a\n");

    expect(
      await planDependencyClones({
        ...roots,
        trackedPaths: ["package.json", "bun.lock", "apps/web/package-lock.json"],
      }),
    ).toEqual({ kind: "skip", reason: "lockfile-mismatch" });

    await writeFile(path.join(roots.sourceRoot, "apps/web/package-lock.json"), "source\n");
    expect(
      await planDependencyClones({
        ...roots,
        trackedPaths: ["package.json", "bun.lock", "apps/web/package-lock.json"],
      }),
    ).toEqual({ kind: "skip", reason: "lockfile-mismatch" });
  });

  it("plans every workspace package whose source has a real node_modules directory", async () => {
    const roots = await makeCheckouts();
    for (const file of [
      "package.json",
      "bun.lock",
      "apps/web/package.json",
      "apps/linked/package.json",
      "apps/existing/package.json",
      "packages/empty/package.json",
    ]) {
      await writeToBoth(roots, file);
    }
    await writeFile(path.join(roots.sourceRoot, "node_modules/a/index.js"), "a\n");
    await writeFile(path.join(roots.sourceRoot, "apps/web/node_modules/b/index.js"), "b\n");
    await writeFile(path.join(roots.sourceRoot, "apps/existing/node_modules/c/index.js"), "c\n");
    await writeFile(path.join(roots.worktreeRoot, "apps/existing/node_modules/.keep"), "");
    await fs.symlink(
      path.join(roots.sourceRoot, "node_modules"),
      path.join(roots.sourceRoot, "apps/linked/node_modules"),
    );

    const plan = await planDependencyClones({
      ...roots,
      trackedPaths: [
        "package.json",
        "bun.lock",
        "apps/web/package.json",
        "apps/linked/package.json",
        "apps/existing/package.json",
        "packages/empty/package.json",
        "vendor/node_modules/pkg/package.json",
      ],
    });

    expect(plan).toEqual({
      kind: "clone",
      pairs: [
        {
          source: path.join(roots.sourceRoot, "node_modules"),
          target: path.join(roots.worktreeRoot, "node_modules"),
        },
        {
          source: path.join(roots.sourceRoot, "apps/web/node_modules"),
          target: path.join(roots.worktreeRoot, "apps/web/node_modules"),
        },
      ],
    });
  });
});

describe("cloneWorktreeDependencies", () => {
  it("drops path-keyed tool caches from clones and removes failed targets", async () => {
    const roots = await makeCheckouts();
    for (const file of ["package.json", "bun.lock", "apps/web/package.json"]) {
      await writeToBoth(roots, file);
    }
    await writeFile(path.join(roots.sourceRoot, "node_modules/a/index.js"), "a\n");
    await writeFile(path.join(roots.sourceRoot, "node_modules/.vite/deps/a.js"), "cached\n");
    await writeFile(path.join(roots.sourceRoot, "node_modules/.cache/babel/x"), "cached\n");
    await writeFile(path.join(roots.sourceRoot, "apps/web/node_modules/b/index.js"), "b\n");

    const result = await cloneWorktreeDependencies({
      ...roots,
      trackedPaths: ["package.json", "bun.lock", "apps/web/package.json"],
      // The first pair clones; the second leaves a partial tree and reports failure.
      cloneDirectories: async (pairs) => {
        await copyDirectories(pairs);
        return [true, false];
      },
    });

    expect(result).toEqual({ kind: "cloned", cloned: 1, failed: 1 });
    expect(
      await fs.readFile(path.join(roots.worktreeRoot, "node_modules/a/index.js"), "utf8"),
    ).toBe("a\n");
    await expect(fs.stat(path.join(roots.worktreeRoot, "node_modules/.vite"))).rejects.toThrow();
    await expect(fs.stat(path.join(roots.worktreeRoot, "node_modules/.cache"))).rejects.toThrow();
    await expect(fs.stat(path.join(roots.worktreeRoot, "apps/web/node_modules"))).rejects.toThrow();
    expect(
      await fs.readFile(path.join(roots.sourceRoot, "node_modules/.vite/deps/a.js"), "utf8"),
    ).toBe("cached\n");
  });

  it("removes every planned target when the clone helper fails", async () => {
    const roots = await makeCheckouts();
    await writeToBoth(roots, "package.json");
    await writeToBoth(roots, "bun.lock");
    await writeFile(path.join(roots.sourceRoot, "node_modules/a/index.js"), "a\n");

    await expect(
      cloneWorktreeDependencies({
        ...roots,
        trackedPaths: ["package.json", "bun.lock"],
        cloneDirectories: async (pairs) => {
          await copyDirectories(pairs);
          throw new Error("helper timed out");
        },
      }),
    ).rejects.toThrow("helper timed out");
    await expect(fs.stat(path.join(roots.worktreeRoot, "node_modules"))).rejects.toThrow();
  });

  it("does not call the clone helper when there is nothing to clone", async () => {
    const roots = await makeCheckouts();
    await writeToBoth(roots, "package.json");
    await writeToBoth(roots, "bun.lock");

    const result = await cloneWorktreeDependencies({
      ...roots,
      trackedPaths: ["package.json", "bun.lock"],
      cloneDirectories: () => Promise.reject(new Error("must not run")),
    });

    expect(result).toEqual({ kind: "skipped", reason: "nothing-to-clone" });
  });
});

describe.runIf(process.platform === "darwin")("cloneDirectoriesWithClonefile", () => {
  it("clones whole directory trees that diverge from the source on write", async () => {
    const roots = await makeCheckouts();
    const source = path.join(roots.sourceRoot, "node_modules");
    const target = path.join(roots.worktreeRoot, "node_modules");
    const existing = path.join(roots.worktreeRoot, "existing");
    await writeFile(path.join(source, "a/index.js"), "a\n");
    await fs.symlink("a/index.js", path.join(source, "entry.js"));
    await fs.mkdir(existing);

    const outcomes = await cloneDirectoriesWithClonefile([
      { source, target },
      { source, target: existing },
    ]);

    expect(outcomes).toEqual([true, false]);
    expect(await fs.readlink(path.join(target, "entry.js"))).toBe("a/index.js");
    await fs.writeFile(path.join(target, "a/index.js"), "changed\n");
    expect(await fs.readFile(path.join(source, "a/index.js"), "utf8")).toBe("a\n");
    expect(await fs.readdir(existing)).toEqual([]);
  });
});
