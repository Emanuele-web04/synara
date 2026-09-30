// FILE: groupWorkspaceScaffold.test.ts
// Purpose: Verifies group workspace cleanup — removes folders holding only
//          Synara-generated files, keeps anything the user touched, and never
//          escapes the managed groups root or follows symlinks.
// Layer: Server workspace helper tests
// Exports: Vitest suites for groupWorkspaceScaffold.ts

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupGroupWorkspaceRoot,
  ensureGroupWorkspaceInstructionsFiles,
} from "./groupWorkspaceScaffold.ts";

const tempDirectories: Array<string> = [];

async function makeTempDir(prefix = "synara-groups-"): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

async function writeInstructions(workspaceRoot: string): Promise<void> {
  await fs.mkdir(workspaceRoot, { recursive: true });
  await ensureGroupWorkspaceInstructionsFiles(workspaceRoot).pipe(
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );
}

describe("cleanupGroupWorkspaceRoot", () => {
  it("removes a group folder that only contains the generated instruction files", async () => {
    const groupsRoot = await makeTempDir();
    const workspaceRoot = path.join(groupsRoot, "alpha");
    await writeInstructions(workspaceRoot);
    await fs.writeFile(path.join(workspaceRoot, ".DS_Store"), "junk");

    const result = await Effect.runPromise(
      cleanupGroupWorkspaceRoot({ workspaceRoot, groupsWorkspaceRoot: groupsRoot }),
    );

    expect(result).toEqual({ status: "removed", workspaceRoot });
    await expect(fs.lstat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    // The Groups root itself is untouched.
    expect((await fs.readdir(groupsRoot)).length).toBe(0);
  });

  it("removes an already-empty group folder", async () => {
    const groupsRoot = await makeTempDir();
    const workspaceRoot = path.join(groupsRoot, "alpha");
    await fs.mkdir(workspaceRoot);

    const result = await Effect.runPromise(
      cleanupGroupWorkspaceRoot({ workspaceRoot, groupsWorkspaceRoot: groupsRoot }),
    );

    expect(result.status).toBe("removed");
    await expect(fs.lstat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the folder when the user added a file", async () => {
    const groupsRoot = await makeTempDir();
    const workspaceRoot = path.join(groupsRoot, "alpha");
    await writeInstructions(workspaceRoot);
    await fs.writeFile(path.join(workspaceRoot, "notes.txt"), "mine");

    const result = await Effect.runPromise(
      cleanupGroupWorkspaceRoot({ workspaceRoot, groupsWorkspaceRoot: groupsRoot }),
    );

    expect(result).toEqual({ status: "kept", workspaceRoot });
    expect(await fs.readdir(workspaceRoot)).toEqual(
      expect.arrayContaining(["AGENTS.md", "CLAUDE.md", "notes.txt"]),
    );
  });

  it("keeps the folder when the user edited a generated instruction file", async () => {
    const groupsRoot = await makeTempDir();
    const workspaceRoot = path.join(groupsRoot, "alpha");
    await writeInstructions(workspaceRoot);
    await fs.appendFile(path.join(workspaceRoot, "CLAUDE.md"), "\nuser notes\n");

    const result = await Effect.runPromise(
      cleanupGroupWorkspaceRoot({ workspaceRoot, groupsWorkspaceRoot: groupsRoot }),
    );

    expect(result.status).toBe("kept");
    expect(await fs.readFile(path.join(workspaceRoot, "CLAUDE.md"), "utf8")).toContain(
      "user notes",
    );
  });

  it("keeps the folder when it holds a subdirectory (e.g. a repo clone)", async () => {
    const groupsRoot = await makeTempDir();
    const workspaceRoot = path.join(groupsRoot, "alpha");
    await writeInstructions(workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "linked-repo"));

    const result = await Effect.runPromise(
      cleanupGroupWorkspaceRoot({ workspaceRoot, groupsWorkspaceRoot: groupsRoot }),
    );

    expect(result.status).toBe("kept");
    expect(await fs.readdir(workspaceRoot)).toContain("linked-repo");
  });

  it("keeps the folder when an entry is a symlink and never follows it", async () => {
    const groupsRoot = await makeTempDir();
    const outside = await makeTempDir("synara-outside-");
    const secretPath = path.join(outside, "secret.txt");
    await fs.writeFile(secretPath, "do not touch");
    const workspaceRoot = path.join(groupsRoot, "alpha");
    await writeInstructions(workspaceRoot);
    await fs.symlink(secretPath, path.join(workspaceRoot, "link-to-secret"));

    const result = await Effect.runPromise(
      cleanupGroupWorkspaceRoot({ workspaceRoot, groupsWorkspaceRoot: groupsRoot }),
    );

    expect(result.status).toBe("kept");
    // The link target survives — we must never touch files reached through a symlink.
    expect(await fs.readFile(secretPath, "utf8")).toBe("do not touch");
  });

  it("skips a group folder that is itself a symlink, leaving the target alone", async () => {
    const groupsRoot = await makeTempDir();
    const target = await makeTempDir("synara-target-");
    const workspaceRoot = path.join(groupsRoot, "alpha");
    await fs.symlink(target, workspaceRoot);

    const result = await Effect.runPromise(
      cleanupGroupWorkspaceRoot({ workspaceRoot, groupsWorkspaceRoot: groupsRoot }),
    );

    expect(result.status).toBe("skipped");
    expect((await fs.lstat(workspaceRoot)).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(target)).toEqual([]);
  });

  it("skips the groups root itself and folders outside it", async () => {
    const groupsRoot = await makeTempDir();
    const outside = await makeTempDir("synara-outside-");

    await expect(
      Effect.runPromise(
        cleanupGroupWorkspaceRoot({ workspaceRoot: groupsRoot, groupsWorkspaceRoot: groupsRoot }),
      ),
    ).resolves.toEqual({ status: "skipped", workspaceRoot: groupsRoot });
    await expect(
      Effect.runPromise(
        cleanupGroupWorkspaceRoot({ workspaceRoot: outside, groupsWorkspaceRoot: groupsRoot }),
      ),
    ).resolves.toEqual({ status: "skipped", workspaceRoot: outside });
    // A nested path (e.g. <groups>/nested/alpha) is not a managed group folder.
    const nested = path.join(groupsRoot, "nested", "alpha");
    await fs.mkdir(nested, { recursive: true });
    await expect(
      Effect.runPromise(
        cleanupGroupWorkspaceRoot({ workspaceRoot: nested, groupsWorkspaceRoot: groupsRoot }),
      ),
    ).resolves.toEqual({ status: "skipped", workspaceRoot: nested });
    expect(await fs.readdir(groupsRoot)).toContain("nested");
  });

  it("skips a workspace root that does not exist on disk", async () => {
    const groupsRoot = await makeTempDir();
    const workspaceRoot = path.join(groupsRoot, "missing");

    const result = await Effect.runPromise(
      cleanupGroupWorkspaceRoot({ workspaceRoot, groupsWorkspaceRoot: groupsRoot }),
    );

    expect(result).toEqual({ status: "skipped", workspaceRoot });
  });
});
