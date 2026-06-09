import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointRef } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function createGitRepository(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-checkpoint-store-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function createRuntime() {
  const layer = CheckpointStoreLive.pipe(
    Layer.provide(GitCoreLive),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-checkpoint-store-test-" })),
    Layer.provide(NodeServices.layer),
  );
  return ManagedRuntime.make(layer);
}

describe("CheckpointStore", () => {
  let runtime: ManagedRuntime.ManagedRuntime<CheckpointStore, unknown> | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("aliases clean checkpoint captures to HEAD", async () => {
    const cwd = createGitRepository();
    tempDirs.push(cwd);
    runtime = createRuntime();
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    const checkpointRef = CheckpointRef.makeUnsafe("refs/t3/checkpoints/test-clean/turn/0");

    await runtime.runPromise(checkpointStore.captureCheckpoint({ cwd, checkpointRef }));

    expect(runGit(cwd, ["rev-parse", checkpointRef])).toBe(runGit(cwd, ["rev-parse", "HEAD"]));
  });

  it("keeps the full snapshot path for dirty worktrees", async () => {
    const cwd = createGitRepository();
    tempDirs.push(cwd);
    runtime = createRuntime();
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    const checkpointRef = CheckpointRef.makeUnsafe("refs/t3/checkpoints/test-dirty/turn/0");
    fs.writeFileSync(path.join(cwd, "untracked.txt"), "captured\n", "utf8");

    await runtime.runPromise(checkpointStore.captureCheckpoint({ cwd, checkpointRef }));

    expect(runGit(cwd, ["rev-parse", checkpointRef])).not.toBe(runGit(cwd, ["rev-parse", "HEAD"]));
    expect(runGit(cwd, ["show", `${checkpointRef}:untracked.txt`])).toBe("captured");
  });
});
