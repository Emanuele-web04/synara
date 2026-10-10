import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CommandId,
  ProjectId,
  ThreadId,
  TurnId,
  type PullRequestAutoFixState,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Clock,
  Duration,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Scope,
  ServiceMap,
  Stream,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as betaGate from "../../betaFeatureGate";
import { ServerConfig } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore";
import { GitHubCli, type GitHubCliShape } from "../../git/Services/GitHubCli";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore";
import { PullRequestAutoFixRepositoryLive } from "../../persistence/Layers/PullRequestAutoFixRepository";
import { PullRequestAutoFixRepository } from "../../persistence/Services/PullRequestAutoFixRepository";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService";
import { PullRequestAutoFixService } from "../Services/PullRequestAutoFixService";
import { PullRequestAutoFixServiceLive } from "./PullRequestAutoFixService";

const threadId = ThreadId.makeUnsafe("auto-fix-chat");
const url = "https://github.com/o/r/pull/7";
const sha = "a".repeat(40);
const at = "2026-10-03T10:00:00.000Z";
const row = (overrides: Partial<PullRequestAutoFixState> = {}): PullRequestAutoFixState => ({
  threadId,
  pullRequestUrl: url,
  status: "watching",
  pauseReason: null,
  attempts: 0,
  lastHandledHeadSha: null,
  updatedAt: at,
  ...overrides,
});
const observed = (canonical = url) => ({
  summary: {
    number: 7,
    url: canonical,
    state: "open" as const,
    headRefName: "feature/a",
    baseRefName: "main",
    title: "Fix",
    body: "",
    isDraft: false,
  },
  headSha: sha,
  checks: [{ name: "Lint", status: "failure" as const, url: null }],
});
type Observation = Effect.Success<ReturnType<GitHubCliShape["getPullRequestWithChecks"]>>;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function harness(
  options: {
    state?: PullRequestAutoFixState;
    interactionMode?: "plan" | "default";
    activeTurn?: boolean;
    background?: boolean;
    archived?: boolean;
    read?: GitHubCliShape["getPullRequestWithChecks"];
  } = {},
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "synara-auto-fix-test-"));
  let reads = 0;
  const gitHub = {
    withRead: (effect: Effect.Effect<unknown, unknown>) => effect,
    getPullRequestWithChecks: (input: { cwd: string; reference: string }) => {
      reads++;
      return options.read ? options.read(input) : Effect.succeed(observed() as Observation);
    },
  } as unknown as GitHubCliShape;
  const git = {
    statusDetails: () => Effect.succeed({ branch: "feature/a", hasWorkingTreeChanges: false }),
    execute: () => Effect.succeed({ code: 0, stdout: sha, stderr: "" }),
  } as unknown as GitCoreShape;
  const provider = {
    hasLiveRuntimeTasks: () => Effect.succeed(options.background ?? false),
  } as unknown as ProviderServiceShape;
  const engineLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const base = Layer.mergeAll(
    engineLayer,
    OrchestrationProjectionSnapshotQueryLive,
    OrchestrationCommandReceiptRepositoryLive,
    PullRequestAutoFixRepositoryLive,
    Layer.succeed(GitHubCli, gitHub),
    Layer.succeed(GitCore, git),
    Layer.succeed(ProviderService, provider),
  ).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(home, home)),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(TestClock.layer()),
  );
  const runtime = ManagedRuntime.make(base);
  let scope: Scope.Closeable | undefined;
  cleanup.push(async () => {
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await runtime.runPromise(TestClock.setTime(Date.now()).pipe(Effect.scoped));
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const repository = await runtime.runPromise(Effect.service(PullRequestAutoFixRepository));
  const snapshot = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const projectId = ProjectId.makeUnsafe("auto-fix-project");
  await runtime.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("project"),
      projectId,
      title: "Project",
      workspaceRoot: home,
      defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
      createdAt: at,
    }),
  );
  await runtime.runPromise(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("thread"),
      threadId,
      projectId,
      title: "Chat",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      interactionMode: options.interactionMode ?? "default",
      runtimeMode: "approval-required",
      branch: "feature/a",
      worktreePath: null,
      createdAt: at,
    }),
  );
  if (options.activeTurn)
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("session"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: TurnId.makeUnsafe("unsettled"),
          updatedAt: at,
          lastError: null,
        },
        createdAt: at,
      }),
    );
  if (options.archived)
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive"),
        threadId,
      }),
    );
  if (options.state) await runtime.runPromise(repository.upsert(options.state));
  const services = await runtime.services();
  let completedPolls = 0;
  const clock = ServiceMap.get(services, Clock.Clock);
  const observedClock = {
    ...clock,
    sleep: (duration: Duration.Duration) => {
      if (Duration.toMillis(duration) === 60_000) completedPolls++;
      return clock.sleep(duration);
    },
  };
  const watcherServices = ServiceMap.add(services, Clock.Clock, observedClock);
  const start = async () => {
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = await Effect.runPromise(Scope.make("sequential"));
    const map = await Effect.runPromise(
      Layer.buildWithScope(
        PullRequestAutoFixServiceLive.pipe(Layer.provide(Layer.succeedServices(watcherServices))),
        scope,
      ),
    );
    return ServiceMap.get(map, PullRequestAutoFixService);
  };
  const states = () => runtime.runPromise(repository.listByThread({ threadId }));
  const turns = async () =>
    (await runtime.runPromise(Stream.runCollect(engine.readEvents(0)))).filter(
      (event) => event.type === "thread.turn-start-requested",
    );
  const settled = (count = 1) => expect.poll(() => completedPolls).toBeGreaterThanOrEqual(count);
  const tick = async (duration: Duration.Input = "60 seconds") => {
    if (duration === "0 seconds") return settled();
    await settled();
    const next = completedPolls + 1;
    await runtime.runPromise(TestClock.adjust(duration).pipe(Effect.scoped));
    await settled(next);
  };
  return {
    runtime,
    engine,
    repository,
    snapshot,
    start,
    states,
    turns,
    tick,
    settled,
    reads: () => reads,
  };
}

async function blockedRead() {
  const entered = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  let first = true;
  const read: GitHubCliShape["getPullRequestWithChecks"] = () =>
    Effect.gen(function* () {
      if (first) {
        first = false;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      }
      return observed() as Observation;
    });
  return {
    read,
    entered: () => Effect.runPromise(Deferred.await(entered)),
    release: () => Effect.runPromise(Deferred.succeed(release, undefined)),
  };
}

describe("Auto-fix service durable decisions", () => {
  it("keeps a disabled host inert and rejects both RPC operations", async () => {
    const gate = vi.spyOn(betaGate, "isServerBetaFeatureEnabled").mockReturnValue(false);
    try {
      const original = row({ status: "fixing", attempts: 1, lastHandledHeadSha: sha });
      const h = await harness({ state: original });
      const service = await h.start();
      await h.runtime.runPromise(TestClock.adjust("60 seconds").pipe(Effect.scoped));
      expect(await h.states()).toEqual([original]);
      expect(h.reads()).toBe(0);
      expect(await h.turns()).toEqual([]);
      expect(Exit.isFailure(await Effect.runPromiseExit(service.get({ threadId })))).toBe(true);
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(
            service.set({ threadId, pullRequestUrl: url, enabled: true }),
          ),
        ),
      ).toBe(true);
    } finally {
      gate.mockRestore();
    }
  });
  it("does not recreate a disabled watch after an in-flight GitHub poll", async () => {
    const gate = await blockedRead();
    const h = await harness({ state: row(), read: gate.read });
    const service = await h.start();
    await gate.entered();
    await Effect.runPromise(service.set({ threadId, pullRequestUrl: url, enabled: false }));
    await gate.release();
    await h.tick();
    expect(await h.states()).toEqual([]);
    expect(await h.turns()).toEqual([]);
  });
  it("rechecks a turn that starts while GitHub is still loading", async () => {
    const gate = await blockedRead();
    const h = await harness({ state: row(), read: gate.read });
    await h.start();
    await gate.entered();
    await h.runtime.runPromise(
      h.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("busy-after-fetch"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: TurnId.makeUnsafe("unsettled"),
          updatedAt: at,
          lastError: null,
        },
        createdAt: at,
      }),
    );
    await gate.release();
    await h.settled();
    expect(await h.turns()).toEqual([]);
    expect((await h.states())[0]?.status).toBe("watching");
  });
  it("preserves a re-enabled revision instead of dispatching from a stale poll", async () => {
    const gate = await blockedRead();
    const h = await harness({ state: row(), read: gate.read });
    const service = await h.start();
    await gate.entered();
    const result = await Effect.runPromise(
      service.set({ threadId, pullRequestUrl: url, enabled: true }),
    );
    await gate.release();
    await h.tick("0 seconds");
    await expect.poll(h.states).toEqual([result.state]);
    expect(await h.turns()).toEqual([]);
  });
  it("a disable supersedes an enable that is still resolving GitHub", async () => {
    const gate = await blockedRead();
    const h = await harness({ read: gate.read });
    const service = await h.start();
    const enabling = Effect.runPromise(
      service.set({ threadId, pullRequestUrl: url, enabled: true }),
    );
    await gate.entered();
    await Effect.runPromise(service.set({ threadId, pullRequestUrl: url, enabled: false }));
    await gate.release();
    await enabling;
    expect(await h.states()).toEqual([]);
    expect(await h.turns()).toEqual([]);
  });
  it("pauses a durable fixing attempt with no accepted command receipt at restart", async () => {
    const h = await harness({
      state: row({ status: "fixing", attempts: 1, lastHandledHeadSha: sha }),
    });
    await h.start();
    expect(await h.states()).toEqual([
      expect.objectContaining({ status: "paused", pauseReason: "dispatch-interrupted" }),
    ]);
    expect(await h.turns()).toEqual([]);
    const shell = await h.runtime.runPromise(h.snapshot.getThreadDetailById(threadId));
    expect(
      Option.isSome(shell) &&
        shell.value.activities.some((activity) => activity.kind === "pull-request.auto-fix.paused"),
    ).toBe(true);
  });
  it("recovers an orphan on an archived thread without failing server startup", async () => {
    const h = await harness({
      archived: true,
      state: row({ status: "fixing", attempts: 1, lastHandledHeadSha: sha }),
    });
    await h.start();
    await h.tick();
    expect(await h.turns()).toEqual([]);
    expect(await h.states()).toEqual([]);
  });
  it.each([{ activeTurn: true }, { background: true }, { interactionMode: "plan" as const }])(
    "does not dispatch while thread execution is unavailable: %j",
    async (guard) => {
      const h = await harness({ ...guard, state: row() });
      await h.start();
      await h.tick();
      expect(await h.turns()).toEqual([]);
      expect((await h.states())[0]?.status).toBe("watching");
    },
  );
  it("disables a redirected canonical watch using its saved alias without a GitHub read", async () => {
    const alias = "https://github.com/OLD/Repo/pull/7/files?x=1";
    const h = await harness({ read: () => Effect.succeed(observed(url) as Observation) });
    const service = await h.start();
    const result = await Effect.runPromise(
      service.set({ threadId, pullRequestUrl: alias, enabled: true }),
    );
    expect(result.state?.pullRequestUrl).toBe(url);
    const before = h.reads();
    await Effect.runPromise(service.set({ threadId, pullRequestUrl: alias, enabled: false }));
    expect(h.reads()).toBe(before);
    expect(await h.states()).toEqual([]);
  });
  it.each(["same-head green", "propagated push", "no push"] as const)(
    "waits for head propagation after a real fix turn, then handles %s",
    async (outcome) => {
      let observation: Observation = observed() as Observation;
      const h = await harness({ state: row(), read: () => Effect.succeed(observation) });
      await h.start();
      await h.settled();
      expect(await h.turns()).toHaveLength(1);
      const fixing = (await h.states())[0]!;
      const turnId = TurnId.makeUnsafe("completed-auto-fix");
      for (const status of ["running", "ready"] as const) {
        await h.runtime.runPromise(
          h.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe(`fix-${status}`),
            threadId,
            session: {
              threadId,
              status,
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: status === "running" ? turnId : null,
              updatedAt: fixing.updatedAt,
              lastError: null,
            },
            createdAt: fixing.updatedAt,
          }),
        );
      }
      observation = {
        ...observation,
        checks: [
          {
            name: "Lint",
            status: outcome === "same-head green" ? "success" : "pending",
            url: null,
          },
        ],
      };
      await h.tick();
      expect((await h.states())[0]?.status).toBe(
        outcome === "same-head green" ? "watching" : "fixing",
      );
      if (outcome === "propagated push") observation = { ...observation, headSha: "b".repeat(40) };
      await h.tick();
      expect(await h.turns()).toHaveLength(1);
      expect(await h.states()).toEqual([
        expect.objectContaining(
          outcome === "no push"
            ? { status: "paused", pauseReason: "no-push", attempts: 1 }
            : {
                status: "watching",
                pauseReason: null,
                attempts: outcome === "same-head green" ? 0 : 1,
              },
        ),
      ]);
    },
  );
  it("persists a real accepted fix and does not dispatch it again after watcher restart", async () => {
    const h = await harness({ state: row() });
    await h.start();
    await expect.poll(h.turns).toHaveLength(1);
    expect((await h.states())[0]?.status).toBe("fixing");
    await h.start();
    await h.tick();
    expect(await h.turns()).toHaveLength(1);
  });
});
