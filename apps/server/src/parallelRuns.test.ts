import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ThreadId,
  ModelSelection,
  type OrchestrationStartParallelRunInput,
  type OrchestrationCommand,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { ServerConfig } from "./config";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitCore } from "./git/Services/GitCore";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { ProviderRuntimeEventRepositoryLive } from "./persistence/Layers/ProviderRuntimeEvents";
import { makeSqlitePersistenceLive } from "./persistence/Layers/Sqlite";
import { ServerSettingsService } from "./serverSettings";
import { startParallelRun } from "./parallelRuns";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const selection = Schema.decodeUnknownSync(ModelSelection)({
  provider: "codex",
  instanceId: "codex",
  model: "gpt-5",
});

it("persists the entire batch before a real Git lock failure and preserves a nested working directory on recovery", async () => {
  const h = await harness();
  try {
    const nested = path.join(h.repo, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "package.txt"), "nested base");
    git(h.repo, "add", ".");
    git(h.repo, "commit", "-m", "nested project");
    await h.runtime.runPromise(
      h.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("nested-directory"),
        threadId: h.input.sourceThreadId,
        workingDirectory: nested,
      }),
    );
    const base = git(h.repo, "rev-parse", "HEAD");
    const lock = path.join(
      h.repo,
      ".git",
      "refs",
      "heads",
      "synara",
      "parallel",
      h.input.runId,
      "1.lock",
    );
    await fs.mkdir(path.dirname(lock), { recursive: true });
    await fs.writeFile(lock, "held by another Git operation");
    await expect(
      h.runtime.runPromise(
        startParallelRun(h.input, { git: h.core, query: h.query, dispatch: h.dispatch }),
      ),
    ).rejects.toThrow();
    const pending = (await h.runtime.runPromise(h.query.getShellSnapshot())).threads.filter(
      (thread) => thread.parallelRun?.runId === h.input.runId,
    );
    expect(pending).toHaveLength(3);
    expect(
      pending.every((thread) => !thread.worktreePath && !thread.latestTurn && !thread.session),
    ).toBe(true);
    expect(git(h.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    await fs.unlink(lock);
    await fs.writeFile(path.join(h.repo, "later.txt"), "new source commit");
    git(h.repo, "add", ".");
    git(h.repo, "commit", "-m", "source moved");
    const result = await h.runtime.runPromise(
      startParallelRun(pending[0]!.parallelRun!.request!, {
        git: h.core,
        query: h.query,
        dispatch: h.dispatch,
      }),
    );
    expect(result.baseCommit).toBe(base);
    const recovered = (await h.runtime.runPromise(h.query.getShellSnapshot())).threads.filter(
      (thread) => thread.parallelRun?.runId === h.input.runId,
    );
    for (const thread of recovered) {
      expect(thread.workingDirectory).toBe(path.join(thread.worktreePath!, "packages", "app"));
      expect(await fs.readFile(path.join(thread.workingDirectory!, "package.txt"), "utf8")).toBe(
        "nested base",
      );
      expect(git(thread.worktreePath!, "rev-parse", "HEAD")).toBe(base);
    }
  } finally {
    await h.runtime.dispose();
  }
}, 30_000);

async function harness() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "synara-parallel-test-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  await fs.writeFile(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const config = ServerConfig.layerTest(repo, path.join(root, "home"));
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      OrchestrationEngineLive.pipe(
        Layer.provideMerge(OrchestrationProjectionPipelineLive),
        Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
        Layer.provideMerge(OrchestrationEventStoreLive),
        Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
        Layer.provideMerge(makeSqlitePersistenceLive(path.join(root, "parallel.sqlite"))),
        Layer.provide(ServerSettingsService.layerTest()),
      ),
      GitCoreLive,
    ).pipe(Layer.provide(config), Layer.provide(NodeServices.layer)),
  );
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const core = await runtime.runPromise(Effect.service(GitCore));
  const createdAt = "2026-10-11T17:00:00.000Z";
  const projectId = ProjectId.makeUnsafe("project");
  const sourceThreadId = ThreadId.makeUnsafe("source");
  await runtime.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("project"),
      projectId,
      title: "Project",
      workspaceRoot: repo,
      defaultModelSelection: selection,
      createdAt,
    }),
  );
  await runtime.runPromise(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("source"),
      threadId: sourceThreadId,
      projectId,
      title: "Source",
      modelSelection: selection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      envMode: "local",
      branch: "main",
      worktreePath: null,
      createdAt,
    }),
  );
  const input: OrchestrationStartParallelRunInput = {
    runId: "11111111-1111-4111-8111-111111111111",
    sourceThreadId,
    prompt: "Implement the task",
    runtimeMode: "approval-required",
    interactionMode: "default",
    attempts: [selection, selection, selection],
    createdAt,
  };
  return {
    repo,
    runtime,
    engine,
    query,
    core,
    input,
    dispatch: (
      command: Parameters<typeof startParallelRun>[1]["dispatch"] extends (
        command: infer C,
      ) => unknown
        ? C
        : never,
    ) => engine.dispatch(command as OrchestrationCommand),
  };
}

it("stages distinct real worktrees at one frozen commit and retries an acknowledged-but-lost turn only once", async () => {
  const h = await harness();
  try {
    const base = git(h.repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(h.repo, "uncommitted.txt"), "not part of the base");
    let loseReceipt = true;
    await expect(
      h.runtime.runPromise(
        startParallelRun(h.input, {
          git: h.core,
          query: h.query,
          dispatch: (command) =>
            h.dispatch(command).pipe(
              Effect.flatMap((receipt) => {
                if (
                  loseReceipt &&
                  command.type === "thread.turn.start" &&
                  command.threadId.endsWith("-1")
                ) {
                  loseReceipt = false;
                  return Effect.fail(new Error("lost response"));
                }
                return Effect.succeed(receipt);
              }),
            ),
        }),
      ),
    ).rejects.toThrow("lost response");
    git(h.repo, "add", ".");
    git(h.repo, "commit", "-m", "source moved");
    const result = await h.runtime.runPromise(
      startParallelRun(h.input, { git: h.core, query: h.query, dispatch: h.dispatch }),
    );
    expect(result.baseCommit).toBe(base);
    const snapshot = await h.runtime.runPromise(h.query.getSnapshot());
    const attempts = snapshot.threads.filter(
      (thread) => thread.parallelRun?.runId === h.input.runId,
    );
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((thread) => thread.worktreePath)).size).toBe(3);
    for (const attempt of attempts) {
      expect(attempt.parentThreadId).toBeNull();
      expect(attempt.session?.threadId).toBe(attempt.id);
      expect(git(attempt.worktreePath!, "rev-parse", "HEAD")).toBe(base);
      expect(attempt.messages.filter((message) => message.role === "user")).toHaveLength(1);
      await expect(
        fs.stat(path.join(attempt.worktreePath!, "uncommitted.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await fs.writeFile(path.join(attempts[0]!.worktreePath!, "only-first.txt"), "independent");
    await expect(
      fs.stat(path.join(attempts[1]!.worktreePath!, "only-first.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      h.runtime.runPromise(
        startParallelRun(
          { ...h.input, prompt: "changed task" },
          { git: h.core, query: h.query, dispatch: h.dispatch },
        ),
      ),
    ).rejects.toThrow("already bound");
  } finally {
    await h.runtime.dispose();
  }
}, 30_000);

it("refuses an oversized batch before creating any attempt", async () => {
  const h = await harness();
  try {
    await expect(
      h.runtime.runPromise(
        startParallelRun(
          { ...h.input, attempts: Array(4).fill(selection) },
          { git: h.core, query: h.query, dispatch: h.dispatch },
        ),
      ),
    ).rejects.toThrow("two or three");
    expect(git(h.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  } finally {
    await h.runtime.dispose();
  }
}, 30_000);

it("recovers a partially staged launch from persisted metadata before starting any provider work", async () => {
  const h = await harness();
  try {
    const base = git(h.repo, "rev-parse", "HEAD");
    let lost = true;
    await expect(
      h.runtime.runPromise(
        startParallelRun(h.input, {
          git: h.core,
          query: h.query,
          dispatch: (command) =>
            h.dispatch(command).pipe(
              Effect.flatMap((receipt) => {
                if (lost && command.type === "thread.create" && command.threadId.endsWith("-1")) {
                  lost = false;
                  return Effect.fail(new Error("lost staging receipt"));
                }
                return Effect.succeed(receipt);
              }),
            ),
        }),
      ),
    ).rejects.toThrow("lost staging receipt");
    const staged = (await h.runtime.runPromise(h.query.getShellSnapshot())).threads.filter(
      (thread) => thread.parallelRun?.runId === h.input.runId,
    );
    expect(staged).toHaveLength(2);
    expect(staged.every((thread) => thread.latestTurn === null && thread.session === null)).toBe(
      true,
    );
    const savedRequest = staged[0]!.parallelRun!.request!;
    expect(savedRequest).toEqual(h.input);
    await fs.writeFile(path.join(h.repo, "later.txt"), "later");
    git(h.repo, "add", ".");
    git(h.repo, "commit", "-m", "later");
    const recovered = await h.runtime.runPromise(
      startParallelRun(savedRequest, { git: h.core, query: h.query, dispatch: h.dispatch }),
    );
    expect(recovered.baseCommit).toBe(base);
    const attempts = (await h.runtime.runPromise(h.query.getShellSnapshot())).threads.filter(
      (thread) => thread.parallelRun?.runId === h.input.runId,
    );
    expect(attempts).toHaveLength(3);
    expect(
      attempts.every(
        (thread) =>
          thread.session?.status === "starting" && thread.runtimeMode === "approval-required",
      ),
    ).toBe(true);
  } finally {
    await h.runtime.dispose();
  }
}, 30_000);
