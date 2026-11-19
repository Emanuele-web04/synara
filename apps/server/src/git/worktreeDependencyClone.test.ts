import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runProcess } from "../processRunner.ts";

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
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "worktree-dependency-clone-")),
  );
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "source");
  const worktreeRoot = path.join(root, "managed", "worktree");
  await fs.mkdir(sourceRoot);
  await fs.mkdir(worktreeRoot, { recursive: true });
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

async function makeGitCheckouts(ignoreDependencies = true) {
  const roots = await makeCheckouts();
  await runProcess("git", ["init", "--quiet"], { cwd: roots.worktreeRoot });
  await fs.writeFile(
    path.join(roots.worktreeRoot, ".gitignore"),
    ignoreDependencies ? "node_modules/\n" : "!node_modules/\n",
  );
  return roots;
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

  it("skips matching lockfile contents stored behind a symlink or beyond the read limit", async () => {
    const roots = await makeCheckouts();
    await writeToBoth(roots, "package.json");
    await writeToBoth(roots, "bun.lock");
    await writeFile(path.join(roots.sourceRoot, "node_modules/a/index.js"), "a\n");
    const sourceLockfile = path.join(roots.sourceRoot, "bun.lock");
    const targetLockfile = path.join(roots.worktreeRoot, "bun.lock");
    await fs.rename(sourceLockfile, sourceLockfile + ".real");
    await fs.symlink("bun.lock.real", sourceLockfile);
    const plan = () =>
      planDependencyClones({ ...roots, trackedPaths: ["package.json", "bun.lock"] });
    const skipped = { kind: "skip", reason: "lockfile-mismatch" };
    expect(await plan()).toEqual(skipped);

    await fs.unlink(sourceLockfile);
    await fs.rename(sourceLockfile + ".real", sourceLockfile);
    await fs.truncate(sourceLockfile, 16 * 1024 * 1024 + 1);
    await fs.truncate(targetLockfile, 16 * 1024 * 1024 + 1);
    expect(await plan()).toEqual(skipped);
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

describe.runIf(process.platform === "darwin")("cloneWorktreeDependencies", () => {
  it("cleans staged caches and discards unsuccessful private copies", async () => {
    const roots = await makeGitCheckouts();
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

  it("preserves a concurrently created destination when the helper fails", async () => {
    const roots = await makeGitCheckouts();
    await writeToBoth(roots, "package.json");
    await writeToBoth(roots, "bun.lock");
    await writeFile(path.join(roots.sourceRoot, "node_modules/a/index.js"), "a\n");

    await expect(
      cloneWorktreeDependencies({
        ...roots,
        trackedPaths: ["package.json", "bun.lock"],
        cloneDirectories: async (pairs) => {
          await copyDirectories(pairs);
          await writeFile(path.join(roots.worktreeRoot, "node_modules/installer"), "owned");
          throw new Error("helper timed out");
        },
      }),
    ).rejects.toThrow("helper timed out");
    expect(await fs.readFile(path.join(roots.worktreeRoot, "node_modules/installer"), "utf8")).toBe(
      "owned",
    );
    expect(
      (await fs.readdir(path.dirname(roots.worktreeRoot))).filter((name) =>
        name.startsWith(".synara-deps-"),
      ),
    ).toEqual([]);
  });

  it("preserves an empty destination created after an actual APFS clone", async () => {
    const roots = await makeGitCheckouts();
    await writeToBoth(roots, "package.json");
    await writeToBoth(roots, "bun.lock");
    await writeFile(path.join(roots.sourceRoot, "node_modules/a/index.js"), "a\n");
    const target = path.join(roots.worktreeRoot, "node_modules");
    const result = await cloneWorktreeDependencies({
      ...roots,
      trackedPaths: ["package.json", "bun.lock"],
      cloneDirectories: async (pairs) => {
        const result = await cloneDirectoriesWithClonefile(pairs);
        expect(result).toEqual([true]);
        // A plain rename could replace an empty directory.
        await fs.mkdir(target);
        return result;
      },
    });
    expect(result).toEqual({ kind: "cloned", cloned: 0, failed: 1 });
    expect(await fs.readdir(target)).toEqual([]);
    expect(
      (await fs.readdir(path.dirname(roots.worktreeRoot))).filter((name) =>
        name.startsWith(".synara-deps-"),
      ),
    ).toEqual([]);
  });

  it("keeps portable links and skips trees with absolute or relocated external links", async () => {
    const roots = await makeGitCheckouts();
    for (const file of [
      "package.json",
      "bun.lock",
      "Linked package/package.json",
      "External package/package.json",
    ]) {
      await writeToBoth(roots, file);
    }
    const portable = path.join(roots.sourceRoot, "node_modules");
    const linked = path.join(roots.sourceRoot, "Linked package/node_modules");
    const external = path.join(roots.sourceRoot, "External package/node_modules");
    await fs.mkdir(external, { recursive: true });
    await writeFile(path.join(path.dirname(roots.sourceRoot), "local-package/index.js"), "local\n");
    await writeFile(path.join(portable, "a/index.js"), "a\n");
    await writeFile(path.join(linked, "b/index.js"), "b\n");
    await fs.symlink("a/index.js", path.join(portable, "entry.js"));
    await fs.symlink(path.join(linked, "b/index.js"), path.join(linked, "entry.js"));
    await fs.symlink("../../../local-package/index.js", path.join(external, "entry.js"));
    expect(await fs.readFile(path.join(external, "entry.js"), "utf8")).toBe("local\n");
    const result = await cloneWorktreeDependencies({
      ...roots,
      trackedPaths: [
        "package.json",
        "bun.lock",
        "Linked package/package.json",
        "External package/package.json",
      ],
    });
    expect(result).toEqual({ kind: "cloned", cloned: 1, failed: 2 });
    const published = path.join(roots.worktreeRoot, "node_modules");
    expect(await fs.readlink(path.join(published, "entry.js"))).toBe("a/index.js");
    await fs.writeFile(path.join(published, "a/index.js"), "changed\n");
    expect(await fs.readFile(path.join(portable, "a/index.js"), "utf8")).toBe("a\n");
    await expect(
      fs.stat(path.join(roots.worktreeRoot, "Linked package/node_modules")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(roots.worktreeRoot, "External package/node_modules")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["published", "rejected", "occupied"] as const)(
    "publishes a pnpm workspace dependency only when its shared store is %s",
    async (storeState) => {
      const roots = await makeGitCheckouts();
      const trackedPaths = ["package.json", "pnpm-lock.yaml", "apps/web/package.json"];
      for (const file of trackedPaths) await writeToBoth(roots, file);
      const dependency = "node_modules/.pnpm/foo@1.0.0/node_modules/foo/index.js";
      const workspaceModule = "apps/web/node_modules/foo";
      await writeFile(path.join(roots.sourceRoot, dependency), "shared package\n");
      const workspaceLink = path.join(roots.sourceRoot, workspaceModule);
      await fs.mkdir(path.dirname(workspaceLink), { recursive: true });
      await fs.symlink("../../../node_modules/.pnpm/foo@1.0.0/node_modules/foo", workspaceLink);
      expect(await fs.readFile(path.join(workspaceLink, "index.js"), "utf8")).toBe(
        "shared package\n",
      );
      if (storeState === "rejected") {
        await fs.symlink(
          path.join(roots.sourceRoot, dependency),
          path.join(roots.sourceRoot, "node_modules/absolute-link"),
        );
      }
      const result = await cloneWorktreeDependencies({
        ...roots,
        trackedPaths,
        cloneDirectories: async (pairs, signal) => {
          const outcomes = await cloneDirectoriesWithClonefile(pairs, signal);
          if (storeState === "occupied") {
            await writeFile(path.join(roots.worktreeRoot, "node_modules/installing"), "owned\n");
          }
          return outcomes;
        },
      });

      const cloned = storeState === "published" ? 2 : 0;
      expect(result).toEqual({ kind: "cloned", cloned, failed: 2 - cloned });
      if (storeState === "published") {
        expect(
          await fs.readFile(path.join(roots.worktreeRoot, workspaceModule, "index.js"), "utf8"),
        ).toBe("shared package\n");
      } else {
        await expect(
          fs.lstat(path.join(roots.worktreeRoot, workspaceModule)),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      if (storeState === "occupied") {
        expect(
          await fs.readFile(path.join(roots.worktreeRoot, "node_modules/installing"), "utf8"),
        ).toBe("owned\n");
      }
    },
  );

  it("does not clone a directory Git would report as untracked", async () => {
    const roots = await makeGitCheckouts(false);
    await writeToBoth(roots, "package.json");
    await writeToBoth(roots, "bun.lock");
    await fs.writeFile(path.join(roots.sourceRoot, ".gitignore"), "node_modules/\n");
    await writeFile(path.join(roots.sourceRoot, "node_modules/a/index.js"), "a\n");
    expect(
      await cloneWorktreeDependencies({
        ...roots,
        trackedPaths: ["package.json", "bun.lock"],
        cloneDirectories: () => Promise.reject(new Error("must not clone an unignored directory")),
      }),
    ).toEqual({ kind: "skipped", reason: "target-not-ignored" });
    await expect(fs.stat(path.join(roots.worktreeRoot, "node_modules"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not call the clone helper when there is nothing to clone", async () => {
    const roots = await makeGitCheckouts();
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
