// FILE: CheckpointStore.test.ts
// Purpose: Verifies filesystem checkpoint store behavior around expensive Git capture work.
// Layer: Checkpointing tests.
// Exports: Vitest coverage for CheckpointStoreLive.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  chmodSync,
  renameSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { ServerConfig } from "../../config.ts";
import { CheckpointRef, ThreadId, TurnId } from "@synara/contracts";
import { checkpointRefForThreadTurn, checkpointRefForThreadTurnLive } from "../Utils.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

// Mocked repositories have no HEAD to record and checkpoints without a recorded
// HEAD, so captures and diffs keep their pre-trailer command sequence.
function legacyCheckpointLookup(args: string) {
  return args === "rev-parse --verify --quiet HEAD^{commit}" || args.startsWith("cat-file commit ")
    ? Effect.succeed({ code: 1, stdout: "", stderr: "" })
    : undefined;
}

describe("CheckpointStoreLive", () => {
  let runtime: ManagedRuntime.ManagedRuntime<CheckpointStore, unknown> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("deduplicates concurrent captures for the same checkpoint ref", async () => {
    let releaseAdd: (() => void) | undefined;
    const addGate = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: "/repo/.git/index\n", stderr: "" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "add -A -- .") {
        return Effect.promise(() => addGate).pipe(Effect.as({ code: 0, stdout: "", stderr: "" }));
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      const legacy = legacyCheckpointLookup(args);
      if (legacy) return legacy;
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const input = {
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/message"),
        };

        const first = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          waitFor(() => execute.mock.calls.some(([call]) => call.args.join(" ") === "add -A -- .")),
        );
        const second = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

        expect(
          execute.mock.calls.filter(([call]) => call.args.join(" ") === "add -A -- ."),
        ).toHaveLength(1);

        releaseAdd?.();
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }),
    );
  });

  it("seeds a capture from the working index so Git can reuse its stat cache", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "synara-checkpoint-index-test-"));
    const workingIndexPath = join(tempDir, "index");
    writeFileSync(workingIndexPath, "working-index-stat-cache");
    const workingIndexTime = new Date("2020-01-02T03:04:05.000Z");
    utimesSync(workingIndexPath, workingIndexTime, workingIndexTime);
    let capturedSeed = "";
    let capturedIndexMtimeMs = 0;

    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: `${workingIndexPath}\n`, stderr: "" });
      }
      if (args === "update-index --really-refresh") {
        const captureIndexPath = input.env?.GIT_INDEX_FILE ?? "";
        const refreshTime = new Date("2025-01-02T03:04:05.000Z");
        utimesSync(captureIndexPath, refreshTime, refreshTime);
        return Effect.succeed({ code: 1, stdout: "", stderr: "README.md: needs update\n" });
      }
      if (args === "add -A -- .") {
        const captureIndexPath = input.env?.GIT_INDEX_FILE ?? "";
        capturedSeed = readFileSync(captureIndexPath, "utf8");
        capturedIndexMtimeMs = statSync(captureIndexPath).mtimeMs;
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      const legacy = legacyCheckpointLookup(args);
      if (legacy) return legacy;
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* CheckpointStore;
          yield* store.captureCheckpoint({
            cwd: tempDir,
            checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/stat-cache"),
          });
        }),
      );

      expect(capturedSeed).toBe("working-index-stat-cache");
      expect(capturedIndexMtimeMs).toBe(workingIndexTime.getTime());
      expect(
        execute.mock.calls.some(
          ([call]) => call.args.join(" ") === "update-index --really-refresh",
        ),
      ).toBe(true);
      expect(
        execute.mock.calls.some(([call]) => call.args.join(" ") === "rev-parse --verify HEAD"),
      ).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("clears in-flight capture state when the owner is interrupted", async () => {
    let addCalls = 0;
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: "/repo/.git/index\n", stderr: "" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "add -A -- .") {
        addCalls += 1;
        if (addCalls === 1) {
          return Effect.never;
        }
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      const legacy = legacyCheckpointLookup(args);
      if (legacy) return legacy;
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const input = {
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/message"),
        };

        const first = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => waitFor(() => addCalls === 1));
        const waiter = yield* store.captureCheckpoint(input).pipe(
          Effect.map(() => "completed" as const),
          Effect.catch((error) => Effect.succeed(error._tag)),
          Effect.forkChild,
        );
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

        yield* Fiber.interrupt(first);
        // The owner's interruption must surface to waiters as a typed store
        // error, not replay as the waiter's own fiber being interrupted.
        const waiterResult = yield* Fiber.join(waiter);
        expect(waiterResult).toBe("CheckpointInvariantError");

        const thirdResult = yield* store
          .captureCheckpoint(input)
          .pipe(Effect.timeoutOption("100 millis"));
        expect(Option.isSome(thirdResult)).toBe(true);
        expect(addCalls).toBe(2);
      }),
    );
  });

  it("skips the capture when skipIfExists is set and the ref already exists", async () => {
    const existingRef = "refs/synara-checkpoints/thread/existing";
    const missingRef = "refs/synara-checkpoints/thread/missing";
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === `rev-parse --verify --quiet ${existingRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "existing-commit\n", stderr: "" });
      }
      if (args === `rev-parse --verify --quiet ${missingRef}^{commit}`) {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: "/repo/.git/index\n", stderr: "" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "add -A -- .") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      const legacy = legacyCheckpointLookup(args);
      if (legacy) return legacy;
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const captureArgs = (args: string) =>
          execute.mock.calls.filter(([call]) => call.args.join(" ") === args);

        yield* store.captureCheckpoint({
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe(existingRef),
          skipIfExists: true,
        });
        expect(captureArgs("add -A -- .")).toHaveLength(0);

        yield* store.captureCheckpoint({
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe(missingRef),
          skipIfExists: true,
        });
        expect(captureArgs("add -A -- .")).toHaveLength(1);
        expect(captureArgs(`update-ref ${missingRef} commit-oid`)).toHaveLength(1);
      }),
    );
  });

  it("keeps a/ and b/ prefixes on turn diffs and file undo under diff.noprefix", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "synara-checkpoint-prefix-test-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    try {
      git(["init", "--initial-branch=main"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test User"]);
      git(["config", "core.autocrlf", "false"]);
      git(["config", "diff.noprefix", "true"]);
      mkdirSync(join(cwd, "src"));
      writeFileSync(join(cwd, "src", "file.ts"), "before\n");
      git(["add", "."]);
      git(["commit", "-m", "Initial"]);
      runtime = ManagedRuntime.make(
        CheckpointStoreLive.pipe(
          Layer.provide(
            GitCoreLive.pipe(
              Layer.provide(ServerConfig.layerTest(cwd, { prefix: "synara-checkpoint-prefix-" })),
            ),
          ),
          Layer.provide(NodeServices.layer),
        ),
      );
      const fromRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/start");
      const toRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/end");

      const diff = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* CheckpointStore;
          yield* store.captureCheckpoint({ cwd, checkpointRef: fromRef });
          writeFileSync(join(cwd, "src", "file.ts"), "after\n");
          yield* store.captureCheckpoint({ cwd, checkpointRef: toRef });
          const range = { cwd, fromCheckpointRef: fromRef, toCheckpointRef: toRef };
          const diff = yield* store.diffCheckpoints({ ...range, ignoreWhitespace: false });
          yield* store.reverseCheckpointDiff(range);
          return diff;
        }),
      );

      expect(diff).toContain("diff --git a/src/file.ts b/src/file.ts");
      expect(readFileSync(join(cwd, "src", "file.ts"), "utf8")).toBe("before\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("restores the worktree patch when resetting the index fails during file undo", async () => {
    const fromRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/start");
    const toRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/end");
    const commands: string[] = [];
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      commands.push(args);
      if (args === `rev-parse --verify --quiet ${fromRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "from-oid\n", stderr: "" });
      }
      if (args === `rev-parse --verify --quiet ${toRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "to-oid\n", stderr: "" });
      }
      if (args.startsWith("diff --patch --binary --full-index")) {
        return Effect.succeed({ code: 0, stdout: "turn patch", stderr: "" });
      }
      if (args === "diff --name-only --no-renames -z --relative from-oid to-oid") {
        return Effect.succeed({ code: 0, stdout: "src/file.ts\0", stderr: "" });
      }
      if (input.args[0] === "apply" && input.args[1] === "--reverse") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "reset --quiet from-oid -- src/file.ts") {
        return Effect.fail(
          new GitCommandError({
            operation: input.operation,
            command: args,
            cwd: input.cwd,
            detail: "reset failed",
          }),
        );
      }
      if (input.args[0] === "apply" && input.args[1] === "--whitespace=nowarn") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      const legacy = legacyCheckpointLookup(args);
      if (legacy) return legacy;
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .reverseCheckpointDiff({
            cwd: "/repo",
            fromCheckpointRef: fromRef,
            toCheckpointRef: toRef,
          })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
      }),
    );

    expect(result).toBe("GitCommandError");
    expect(commands.filter((command) => command.startsWith("apply "))).toHaveLength(2);
    expect(commands.at(-1)).toMatch(/^apply --whitespace=nowarn -- /);
  });

  it("reconstructs provider patches from the captured baseline in a private index", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "synara-raw-patch-"));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try {
      git(["init", "--initial-branch=main"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test User"]);
      writeFileSync(join(cwd, "internal.txt"), "hello world\n");
      writeFileSync(join(cwd, "edges.txt"), "\t leading trailing\n");
      writeFileSync(join(cwd, "crlf.txt"), "windows\r\n");
      writeFileSync(join(cwd, "real.txt"), "before\n");
      writeFileSync(join(cwd, "old name.txt"), "renamed content\n");
      writeFileSync(join(cwd, "delete.txt"), "delete me\n");
      writeFileSync(join(cwd, "no-newline.txt"), "before");
      writeFileSync(join(cwd, "binary.dat"), Buffer.from([0, 1, 2]));
      git(["add", "."]);
      git(["commit", "-m", "Captured baseline"]);
      const baseline = CheckpointRef.makeUnsafe("refs/synara/checkpoints/raw/turn-start/exact");
      git(["update-ref", baseline, "HEAD"]);
      writeFileSync(join(cwd, "internal.txt"), "hello  world\n");
      writeFileSync(join(cwd, "edges.txt"), " leading trailing\t \n");
      writeFileSync(join(cwd, "crlf.txt"), "windows \t\r\n");
      writeFileSync(join(cwd, "real.txt"), "after\n");
      writeFileSync(join(cwd, "no-newline.txt"), "after");
      renameSync(join(cwd, "old name.txt"), join(cwd, "new name.txt"));
      chmodSync(join(cwd, "new name.txt"), 0o755);
      rmSync(join(cwd, "delete.txt"));
      writeFileSync(join(cwd, "unicode-π.txt"), "added\n");
      writeFileSync(join(cwd, "binary.dat"), Buffer.from([0, 3, 2]));
      git(["add", "."]);
      const providerPatch = git(["diff", "--cached", "--binary", "--full-index", baseline]);
      // Real staged/working content can diverge after the selected provider event.
      writeFileSync(join(cwd, "real.txt"), "another session\n");
      writeFileSync(join(cwd, "peer.txt"), "unrelated staged work\n");
      git(["add", "peer.txt", "real.txt"]);
      const index = readFileSync(join(cwd, ".git", "index"));
      const refs = git(["for-each-ref", "--format=%(refname)"]);
      runtime = ManagedRuntime.make(
        CheckpointStoreLive.pipe(
          Layer.provide(
            GitCoreLive.pipe(
              Layer.provide(ServerConfig.layerTest(cwd, { prefix: "synara-raw-store-" })),
            ),
          ),
          Layer.provide(NodeServices.layer),
        ),
      );
      const store = await runtime.runPromise(Effect.service(CheckpointStore));
      for (const ignoreWhitespace of [false, true]) {
        const patch = await runtime.runPromise(
          store.diffCheckpoints({
            cwd,
            fromCheckpointRef: baseline,
            toCheckpointRef: CheckpointRef.makeUnsafe("provider-diff:raw"),
            providerPatch,
            ignoreWhitespace,
          }),
        );
        expect(patch).toContain("+after");
        expect(patch).toContain("delete.txt");
        expect(patch).toContain("rename from old name.txt");
        expect(patch).toContain("rename to new name.txt");
        expect(patch).toContain("new mode 100755");
        expect(patch).toContain("No newline at end of file");
        expect(patch).toContain("binary.dat");
        for (const file of ["internal.txt", "edges.txt", "crlf.txt"])
          expect(patch.includes(file)).toBe(!ignoreWhitespace);
        expect(patch).not.toContain("another session");
        expect(patch).not.toContain("peer.txt");
      }
      await expect(
        runtime.runPromise(
          store.diffCheckpoints({
            cwd,
            fromCheckpointRef: baseline,
            toCheckpointRef: CheckpointRef.makeUnsafe("provider-diff:bad"),
            providerPatch: "not a patch",
            ignoreWhitespace: false,
          }),
        ),
      ).rejects.toThrow();
      await expect(
        runtime.runPromise(
          store.diffCheckpoints({
            cwd,
            fromCheckpointRef: baseline,
            toCheckpointRef: CheckpointRef.makeUnsafe("provider-diff:mismatch"),
            providerPatch: providerPatch.replace("-before", "-wrong baseline"),
            ignoreWhitespace: false,
          }),
        ),
      ).rejects.toThrow();
      expect(readFileSync(join(cwd, ".git", "index"))).toEqual(index);
      expect(readFileSync(join(cwd, "real.txt"), "utf8")).toBe("another session\n");
      expect(git(["for-each-ref", "--format=%(refname)"])).toBe(refs);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("purges published and crash-orphaned live refs without touching another thread or final checkpoints", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "synara-live-ref-cleanup-"));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    try {
      git(["init", "--initial-branch=main"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test User"]);
      writeFileSync(join(cwd, "file.txt"), "before\n");
      git(["add", "."]);
      git(["commit", "-m", "Initial"]);
      const threadId = ThreadId.makeUnsafe("owned-thread");
      const turnId = TurnId.makeUnsafe("owned-turn");
      const ownRefs = ["published", "crashed-before-publish"].map((revision) =>
        checkpointRefForThreadTurnLive(threadId, turnId, revision),
      );
      const keptRefs = [
        checkpointRefForThreadTurn(threadId, 1),
        checkpointRefForThreadTurnLive(ThreadId.makeUnsafe("peer-thread"), turnId, "peer"),
      ];
      for (const ref of [...ownRefs, ...keptRefs]) git(["update-ref", ref, "HEAD"]);
      writeFileSync(join(cwd, "file.txt"), "working changes\n");
      const index = readFileSync(join(cwd, ".git", "index"));
      // Linux/macOS Git emits LF; retain the same real Git deletion proof while
      // exercising the Windows-style command-output boundary as well.
      const crlfGit = Layer.effect(
        GitCore,
        Effect.map(Effect.service(GitCore), (core) => ({
          ...core,
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            core
              .execute(input)
              .pipe(
                Effect.map((result) =>
                  input.args[0] === "for-each-ref"
                    ? { ...result, stdout: result.stdout.replaceAll("\n", "\r\n") }
                    : result,
                ),
              ),
        })),
      ).pipe(
        Layer.provide(
          GitCoreLive.pipe(
            Layer.provide(ServerConfig.layerTest(cwd, { prefix: "synara-live-cleanup-" })),
          ),
        ),
      );
      runtime = ManagedRuntime.make(
        CheckpointStoreLive.pipe(Layer.provide(crlfGit), Layer.provide(NodeServices.layer)),
      );
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* CheckpointStore;
          yield* store.deleteCheckpointRefs({ cwd, checkpointRefs: [], liveThreadId: threadId });
        }),
      );
      const refs = git(["for-each-ref", "--format=%(refname)"]);
      for (const ref of ownRefs) expect(refs).not.toContain(ref);
      for (const ref of keptRefs) expect(refs).toContain(ref);
      expect(readFileSync(join(cwd, ".git", "index"))).toEqual(index);
      expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("working changes\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails when a checkpoint ref cannot be deleted", async () => {
    const lockedRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread/turn/locked");
    const deletableRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread/turn/ok");
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === `update-ref -d ${lockedRef}`) {
        return Effect.succeed({ code: 1, stdout: "", stderr: "cannot lock ref\n" });
      }
      if (args === `update-ref -d ${deletableRef}`) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      const legacy = legacyCheckpointLookup(args);
      if (legacy) return legacy;
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .deleteCheckpointRefs({ cwd: "/repo", checkpointRefs: [deletableRef, lockedRef] })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error.message)),
          );
      }),
    );

    // Every ref is still attempted; one loser must not abandon the batch.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).not.toBe("success");
    expect(result).toContain(lockedRef);
    expect(result).toContain("cannot lock ref");
    expect(result).not.toContain(deletableRef);
  });

  it("tolerates deleting checkpoint refs that are already absent", async () => {
    // `git update-ref -d` exits 0 for a ref that does not exist, so the
    // exit-code check must not turn best-effort cleanup into a hard failure.
    const missingRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread/turn/gone");
    const execute = vi.fn<GitCoreShape["execute"]>(() =>
      Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    );
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .deleteCheckpointRefs({ cwd: "/repo", checkpointRefs: [missingRef] })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error.message)),
          );
      }),
    );

    expect(result).toBe("success");
  });
});

const diffedPaths = (diff: string) =>
  [...diff.matchAll(/^diff --git a\/(.+) b\//gm)].map((match) => match[1]);

describe("CheckpointStoreLive history integration", () => {
  // Commits dated before the starting checkpoint model history that already
  // existed (another branch, a remote); undated commits are made during the turn.
  const existingHistoryDate = "2020-01-01T00:00:00Z";
  const fromRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/start");
  const toRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/end");
  let cwd = "";
  let runtime: ManagedRuntime.ManagedRuntime<CheckpointStore, unknown> | null = null;

  const git = (
    args: string[],
    options: { readonly existing?: boolean; readonly input?: string } = {},
  ) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      input: options.input,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: options.existing
        ? {
            ...process.env,
            GIT_AUTHOR_DATE: existingHistoryDate,
            GIT_COMMITTER_DATE: existingHistoryDate,
          }
        : process.env,
    });
  const write = (relativePath: string, contents: string) => {
    mkdirSync(join(cwd, relativePath, ".."), { recursive: true });
    writeFileSync(join(cwd, relativePath), contents);
  };
  const commitExisting = (message: string) => {
    git(["add", "-A"]);
    git(["commit", "-m", message], { existing: true });
  };
  const run = <A>(effect: Effect.Effect<A, unknown, CheckpointStore>) => {
    runtime ??= ManagedRuntime.make(
      CheckpointStoreLive.pipe(
        Layer.provide(
          GitCoreLive.pipe(
            Layer.provide(ServerConfig.layerTest(cwd, { prefix: "synara-history-store-" })),
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    );
    return runtime.runPromise(effect);
  };
  const capture = (checkpointRef: CheckpointRef) =>
    run(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        yield* store.captureCheckpoint({ cwd, checkpointRef });
      }),
    );
  const turnDiff = () =>
    run(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store.diffCheckpoints({
          cwd,
          fromCheckpointRef: fromRef,
          toCheckpointRef: toRef,
          ignoreWhitespace: false,
        });
      }),
    );

  // main gains CI files and a shared change; feature diverges from it.
  const prepareDivergedBranches = () => {
    cwd = mkdtempSync(join(tmpdir(), "synara-history-integration-"));
    git(["init", "--initial-branch=main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "core.autocrlf", "false"]);
    write("src/app.ts", "app v1\n");
    write("README.md", "readme v1\n");
    write("conflict-theirs.txt", "base\n");
    write("conflict-resolved.txt", "base\n");
    commitExisting("Initial");
    git(["switch", "-c", "feature"]);
    write("src/feature.ts", "feature v1\n");
    write("conflict-theirs.txt", "feature side\n");
    write("conflict-resolved.txt", "feature side\n");
    commitExisting("Feature work");
    git(["switch", "main"]);
    write(".github/CI.md", "ci\n");
    write("README.md", "readme v2\n");
    write("conflict-theirs.txt", "main side\n");
    write("conflict-resolved.txt", "main side\n");
    commitExisting("Main work");
    git(["switch", "feature"]);
  };

  afterEach(async () => {
    await runtime?.dispose();
    runtime = null;
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = "";
  });

  it("leaves a merged branch out of the turn diff and undo but keeps the turn's own edits", async () => {
    prepareDivergedBranches();
    await capture(fromRef);

    try {
      git(["merge", "main", "--no-edit"]);
    } catch {
      // Expected: both conflicted files need a resolution.
    }
    write("conflict-theirs.txt", "main side\n");
    write("conflict-resolved.txt", "feature side\nmain side\n");
    git(["add", "-A"]);
    git(["commit", "--no-edit"]);
    write("src/app.ts", "app v2\n");
    await capture(toRef);

    expect(diffedPaths(await turnDiff())).toEqual(["conflict-resolved.txt", "src/app.ts"]);

    const mergeCommit = git(["rev-parse", "HEAD"]).trim();
    await run(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        expect(
          yield* store.reverseCheckpointDiff({
            cwd,
            fromCheckpointRef: fromRef,
            toCheckpointRef: toRef,
          }),
        ).toBe(true);
      }),
    );
    expect(readFileSync(join(cwd, "src", "app.ts"), "utf8")).toBe("app v1\n");
    expect(readFileSync(join(cwd, "conflict-resolved.txt"), "utf8")).toBe("feature side\n");
    expect(readFileSync(join(cwd, ".github", "CI.md"), "utf8")).toBe("ci\n");
    expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe("readme v2\n");
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(mergeCommit);
  });

  it("leaves out a checked-out branch but keeps uncommitted work it discarded", async () => {
    prepareDivergedBranches();
    write("src/feature.ts", "uncommitted\n");
    await capture(fromRef);

    git(["reset", "--hard", "main"]);
    await capture(toRef);

    expect(diffedPaths(await turnDiff())).toEqual(["src/feature.ts"]);
  });

  it("filters merged history for a project in a repository subdirectory", async () => {
    prepareDivergedBranches();
    const repositoryRoot = cwd;
    write("packages/web/index.ts", "web v1\n");
    commitExisting("Add web package");
    cwd = join(repositoryRoot, "packages", "web");
    await capture(fromRef);

    cwd = repositoryRoot;
    try {
      git(["merge", "main", "--no-edit"]);
    } catch {
      // Expected: resolve both conflicts to main's side.
    }
    git(["checkout", "--theirs", "--", "conflict-theirs.txt", "conflict-resolved.txt"]);
    git(["add", "-A"]);
    git(["commit", "--no-edit"]);
    write("packages/web/index.ts", "web v2\n");
    cwd = join(repositoryRoot, "packages", "web");
    await capture(toRef);

    expect(diffedPaths(await turnDiff())).toEqual(["packages/web/index.ts"]);
    cwd = repositoryRoot;
  });

  it("filters incoming changes in a subdirectory with diff.relative enabled", async () => {
    prepareDivergedBranches();
    const repositoryRoot = cwd;
    git(["config", "diff.relative", "true"]);
    git(["switch", "-c", "incoming"]);
    write("pkg/incoming", "initial\n");
    write("pkg/own", "initial\n");
    commitExisting("Add project");
    git(["branch", "working"]);
    write("pkg/incoming", "incoming change\n");
    commitExisting("Update incoming file");
    git(["switch", "working"]);
    cwd = join(repositoryRoot, "pkg");

    try {
      await capture(fromRef);
      git(["merge", "--ff-only", "incoming"]);
      write("own", "authored change\n");
      await capture(toRef);

      expect(diffedPaths(await turnDiff())).toEqual(["pkg/own"]);
      await run(
        Effect.gen(function* () {
          const store = yield* CheckpointStore;
          expect(
            yield* store.reverseCheckpointDiff({
              cwd,
              fromCheckpointRef: fromRef,
              toCheckpointRef: toRef,
            }),
          ).toBe(true);
        }),
      );
      expect(readFileSync(join(cwd, "incoming"), "utf8")).toBe("incoming change\n");
      expect(readFileSync(join(cwd, "own"), "utf8")).toBe("initial\n");
    } finally {
      cwd = repositoryRoot;
    }
  });

  it("keeps commits made during the turn in the turn diff", async () => {
    prepareDivergedBranches();
    await capture(fromRef);

    write("src/feature.ts", "feature v2\n");
    git(["commit", "-am", "Turn work"]);
    await capture(toRef);

    expect(diffedPaths(await turnDiff())).toEqual(["src/feature.ts"]);
  });

  it.each(["file-to-directory", "directory-to-file"])(
    "filters an incoming %s replacement without losing the turn's own edit",
    async (direction) => {
      prepareDivergedBranches();
      const [before, after] =
        direction === "file-to-directory"
          ? (["shape", "shape/child"] as const)
          : (["shape/child", "shape"] as const);
      git(["switch", "-c", "incoming"]);
      write(before, "before\n");
      commitExisting("Original entry");
      git(["branch", "working"]);
      git(["rm", before]);
      write(after, "after\n");
      commitExisting("Replace entry");
      git(["switch", "working"]);
      await capture(fromRef);

      git(["merge", "--ff-only", "incoming"]);
      write("src/app.ts", "app v2\n");
      await capture(toRef);

      expect(diffedPaths(await turnDiff())).toEqual(["src/app.ts"]);
    },
  );

  it.each([
    ["merge", ["merge", "--no-edit", "-Xtheirs", "main"]],
    ["rebase", ["rebase", "-Xours", "main"]],
  ] as const)(
    "keeps a feature-only deletion when the branch used for %s never changed that path",
    async (_, command) => {
      prepareDivergedBranches();
      await capture(fromRef);

      git(["rm", "src/feature.ts"]);
      git(["commit", "-m", "Delete feature-only file during the turn"]);
      git([...command]);
      await capture(toRef);

      expect(diffedPaths(await turnDiff())).toEqual(["src/feature.ts"]);
    },
  );

  it("keeps authored changes when the history walk would omit the first new commit", async () => {
    prepareDivergedBranches();
    await capture(fromRef);

    write("src/feature.ts", "feature v2\n");
    git(["commit", "-am", "Turn work"]);
    const authoredHead = git(["rev-parse", "HEAD"]).trim();
    const identity = `Test User <test@example.com> ${Math.ceil(Date.now() / 1000)} +0000`;
    git(["fast-import", "--quiet"], {
      input:
        Array.from({ length: 1_000 }, (_, index) =>
          [
            "commit refs/heads/feature",
            `committer ${identity}`,
            "data 0",
            ...(index === 0 ? [`from ${authoredHead}`] : []),
            "",
          ].join("\n"),
        ).join("\n") + "\n",
    });
    await capture(toRef);

    expect(diffedPaths(await turnDiff())).toEqual(["src/feature.ts"]);
  });

  it("keeps the full diff for checkpoints captured before HEAD was recorded", async () => {
    prepareDivergedBranches();
    const legacyCommit = git([
      "commit-tree",
      git(["rev-parse", "HEAD^{tree}"]).trim(),
      "-m",
      `Synara checkpoint ref=${fromRef}`,
    ]).trim();
    git(["update-ref", fromRef, legacyCommit]);

    git(["reset", "--hard", "main"]);
    await capture(toRef);

    expect(diffedPaths(await turnDiff())).toContain(".github/CI.md");
  });
});
