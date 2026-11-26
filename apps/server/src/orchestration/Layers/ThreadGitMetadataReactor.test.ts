import {
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThreadPullRequest,
  type OrchestrationThreadPullRequestLink,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import {
  legacyPullRequestLinks,
  linkPullRequest,
  resolveCurrentPullRequest,
  syncDiscoveredPullRequest,
} from "@synara/shared/threadPullRequestLinks";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { GitManagerError } from "../../git/Errors.ts";
import { GitCore, type GitCoreShape, type GitStatusDetails } from "../../git/Services/GitCore.ts";
import { GitManager, type GitManagerShape } from "../../git/Services/GitManager.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadGitMetadataReactor } from "../Services/ThreadGitMetadataReactor.ts";
import { ThreadGitMetadataReactorLive } from "./ThreadGitMetadataReactor.ts";

interface MutableThreadShell {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly envMode: "local" | "worktree";
  readonly worktreePath: string | null;
  branch: string | null;
  lastKnownPr: OrchestrationThreadPullRequest | null;
  pullRequests?: OrchestrationThreadPullRequestLink[];
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
}

const pullRequest: OrchestrationThreadPullRequest = {
  number: 574,
  title: "Cache provider usage",
  url: "https://github.com/Emanuele-web04/synara/pull/574",
  baseBranch: "main",
  headBranch: "feat/provider-usage-snapshot-cache",
  state: "open",
};

const statusDetails = (branch: string): GitStatusDetails => ({
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch,
  upstreamRef: `origin/${branch}`,
  upstreamBranch: branch,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread Git metadata reconciliation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ThreadGitMetadataReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<ThreadGitMetadataReactor, unknown> | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = null;
    if (runtime) await runtime.dispose();
    runtime = null;
  });

  const createHarness = async (input: {
    readonly threads: MutableThreadShell[];
    readonly branchByCwd: Readonly<Record<string, string>>;
    readonly pullRequestLookupFails?: boolean;
  }) => {
    const runtimeEvents = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const commands: OrchestrationCommand[] = [];
    // One entry per reconciliation: the reactor dispatches the workspace patch
    // (`thread.meta.update`) and the branch-discovered PR (`thread.pull-request.sync`) as
    // adjacent commands; tests assert the combined outcome here and the split in `commands`.
    const reconciliations: Array<Record<string, unknown>> = [];
    const pullRequestLookups: string[] = [];
    const resolvedPullRequestReferences: string[] = [];
    const statusCwds: string[] = [];
    for (const thread of input.threads) {
      thread.pullRequests ??= legacyPullRequestLinks(
        thread.lastKnownPr,
        "2026-08-07T09:00:00.000Z",
      );
    }
    const threads = new Map(input.threads.map((thread) => [thread.id, thread]));
    const projectId = input.threads[0]!.projectId;

    const providerService = {
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } as unknown as ProviderServiceShape;
    const projectionSnapshotQuery = {
      getThreadShellById: (threadId: ThreadId) =>
        Effect.succeed(Option.fromNullishOr(threads.get(threadId) as never)),
      getProjectShellById: () =>
        Effect.succeed(
          Option.some({
            id: projectId,
            kind: "project",
            workspaceRoot: "/repo",
          } as never),
        ),
    } as unknown as ProjectionSnapshotQueryShape;
    const gitCore = {
      readBranchContext: (cwd: string) =>
        Effect.sync(() => {
          statusCwds.push(cwd);
          return statusDetails(input.branchByCwd[cwd]!);
        }),
    } as unknown as GitCoreShape;
    const gitManager = {
      pullRequestForBranch: ({ branch }: { branch: string }) =>
        Effect.gen(function* () {
          pullRequestLookups.push(branch);
          if (input.pullRequestLookupFails) {
            return yield* new GitManagerError({
              operation: "pullRequestForBranch",
              detail: "GitHub unavailable",
            });
          }
          return branch === pullRequest.headBranch ? pullRequest : null;
        }),
      resolvePullRequest: ({ reference }: { reference: string }) =>
        Effect.sync(() => {
          resolvedPullRequestReferences.push(reference);
          return { pullRequest: { ...pullRequest, url: reference } };
        }),
    } as unknown as GitManagerShape;
    const orchestrationEngine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "thread.meta.update") {
            const { type: _type, commandId: _commandId, ...patch } = command;
            reconciliations.push(patch);
          }
          if (command.type === "thread.pull-request.sync" && command.discovered !== undefined) {
            const previous = reconciliations.at(-1);
            const previousCommand = commands.at(-2);
            if (
              previous &&
              previousCommand?.type === "thread.meta.update" &&
              previousCommand.threadId === command.threadId
            ) {
              previous.discoveredPullRequest = command.discovered;
            } else {
              reconciliations.push({
                threadId: command.threadId,
                discoveredPullRequest: command.discovered,
              });
            }
            const thread = threads.get(command.threadId);
            if (thread) {
              thread.pullRequests = syncDiscoveredPullRequest(
                thread.pullRequests,
                command.discovered,
                "2026-08-07T10:02:00.000Z",
              );
              thread.lastKnownPr = resolveCurrentPullRequest(thread.pullRequests);
            }
          }
          if (command.type === "thread.pull-request.link") {
            const thread = threads.get(command.threadId);
            if (thread) {
              thread.pullRequests = linkPullRequest(thread.pullRequests, {
                pullRequest: command.pullRequest,
                source: command.source ?? "user",
                linkedAt: "2026-08-07T10:02:00.000Z",
              });
              thread.lastKnownPr = resolveCurrentPullRequest(thread.pullRequests);
            }
          }
          if (command.type === "thread.meta.update") {
            const thread = threads.get(command.threadId);
            if (thread) {
              if (command.branch !== undefined) thread.branch = command.branch;
              if (command.associatedWorktreePath !== undefined) {
                thread.associatedWorktreePath = command.associatedWorktreePath;
              }
              if (command.associatedWorktreeBranch !== undefined) {
                thread.associatedWorktreeBranch = command.associatedWorktreeBranch;
              }
              if (command.associatedWorktreeRef !== undefined) {
                thread.associatedWorktreeRef = command.associatedWorktreeRef;
              }
            }
          }
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineShape;

    const layer = ThreadGitMetadataReactorLive.pipe(
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery)),
      Layer.provideMerge(Layer.succeed(GitCore, gitCore)),
      Layer.provideMerge(Layer.succeed(GitManager, gitManager)),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
    );
    const managedRuntime = ManagedRuntime.make(layer);
    runtime = managedRuntime;
    const reactor = await managedRuntime.runPromise(Effect.service(ThreadGitMetadataReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const publish = (event: ProviderRuntimeEvent) =>
      Effect.runPromise(PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid));

    return {
      commands,
      reconciliations,
      resolvedPullRequestReferences,
      threads,
      pullRequestLookups,
      statusCwds,
      publish,
      drain: () => managedRuntime.runPromise(reactor.drain),
    };
  };

  const startedEvent = (threadId: ThreadId, turnId: TurnId): ProviderRuntimeEvent => ({
    type: "turn.started",
    eventId: EventId.makeUnsafe(`started-${turnId}`),
    provider: "codex",
    threadId,
    turnId,
    createdAt: "2026-08-07T10:00:00.000Z",
    payload: {},
  });

  const completedEvent = (threadId: ThreadId, turnId: TurnId): ProviderRuntimeEvent => ({
    type: "turn.completed",
    eventId: EventId.makeUnsafe(`completed-${turnId}`),
    provider: "codex",
    threadId,
    turnId,
    createdAt: "2026-08-07T10:01:00.000Z",
    payload: { state: "completed" },
  });

  const vcsStateChangedEvent = (
    threadId: ThreadId,
    options?: { readonly cwd?: string; readonly kind?: string; readonly eventId?: string },
  ): ProviderRuntimeEvent => ({
    type: "vcs.state.changed",
    eventId: EventId.makeUnsafe(options?.eventId ?? `vcs-${threadId}`),
    provider: "claudeAgent",
    threadId,
    createdAt: "2026-08-07T10:00:30.000Z",
    payload: {
      kind: options?.kind ?? "commit",
      ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
    },
  });

  const runtimeErrorEvent = (threadId: ThreadId): ProviderRuntimeEvent => ({
    type: "runtime.error",
    eventId: EventId.makeUnsafe(`runtime-error-${threadId}`),
    provider: "codex",
    threadId,
    createdAt: "2026-08-07T10:01:00.000Z",
    payload: { message: "Provider stopped" },
  });

  it("persists the actual worktree branch and PR even when branch metadata is stale", async () => {
    const threadId = ThreadId.makeUnsafe("worktree-thread");
    const turnId = TurnId.makeUnsafe("worktree-turn");
    const harness = await createHarness({
      threads: [
        {
          id: threadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          envMode: "worktree",
          worktreePath: "/repo/.worktrees/thread",
          branch: "synara/stale-branch",
          lastKnownPr: null,
        },
      ],
      branchByCwd: { "/repo/.worktrees/thread": pullRequest.headBranch },
    });

    await harness.publish(completedEvent(threadId, turnId));
    await waitFor(() => harness.statusCwds.length === 1);
    await waitFor(() => harness.reconciliations.length === 1);
    await harness.drain();

    expect(harness.reconciliations[0]).toMatchObject({
      threadId,
      branch: pullRequest.headBranch,
      discoveredPullRequest: pullRequest,
      associatedWorktreePath: "/repo/.worktrees/thread",
      associatedWorktreeBranch: pullRequest.headBranch,
      associatedWorktreeRef: pullRequest.headBranch,
    });
    expect(harness.pullRequestLookups).toEqual([pullRequest.headBranch]);
  });

  it("ignores native subagent lifecycle events while attributing the shared parent turn", async () => {
    const threadId = ThreadId.makeUnsafe("local-parent-thread");
    const parentTurnId = TurnId.makeUnsafe("local-parent-turn");
    const childTurnId = TurnId.makeUnsafe("local-child-turn");
    const childProviderRefs = {
      providerThreadId: "child-provider-thread",
      providerParentThreadId: "parent-provider-thread",
    } as const;
    const harness = await createHarness({
      threads: [
        {
          id: threadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          envMode: "local",
          worktreePath: null,
          branch: "synara/stale-branch",
          lastKnownPr: null,
        },
      ],
      branchByCwd: { "/repo": pullRequest.headBranch },
    });

    await harness.publish(startedEvent(threadId, parentTurnId));
    await harness.publish({
      ...startedEvent(threadId, childTurnId),
      providerRefs: childProviderRefs,
    });
    await harness.publish({
      ...completedEvent(threadId, childTurnId),
      providerRefs: childProviderRefs,
    });
    await harness.publish(completedEvent(threadId, parentTurnId));
    await waitFor(() => harness.reconciliations.length === 1);
    await harness.drain();

    expect(harness.reconciliations[0]).toMatchObject({
      threadId,
      branch: pullRequest.headBranch,
      discoveredPullRequest: pullRequest,
    });
  });

  it("does not claim a shared local checkout without an observed owning turn", async () => {
    const localThreadId = ThreadId.makeUnsafe("unowned-local-thread");
    const worktreeThreadId = ThreadId.makeUnsafe("worktree-flush-thread");
    const harness = await createHarness({
      threads: [
        {
          id: localThreadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          envMode: "local",
          worktreePath: null,
          branch: "synara/local-stale",
          lastKnownPr: null,
        },
        {
          id: worktreeThreadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          envMode: "worktree",
          worktreePath: "/repo/.worktrees/flush",
          branch: "synara/worktree-stale",
          lastKnownPr: null,
        },
      ],
      branchByCwd: {
        "/repo": pullRequest.headBranch,
        "/repo/.worktrees/flush": pullRequest.headBranch,
      },
    });

    await harness.publish(completedEvent(localThreadId, TurnId.makeUnsafe("unowned-turn")));
    await harness.publish(completedEvent(worktreeThreadId, TurnId.makeUnsafe("flush-turn")));
    await waitFor(() => harness.reconciliations.length === 1);
    await harness.drain();

    expect(harness.reconciliations[0]).toMatchObject({
      threadId: worktreeThreadId,
    });
  });

  it("does not let a stale explicit terminal event consume the active shared turn", async () => {
    const localThreadId = ThreadId.makeUnsafe("active-local-thread");
    const sentinelThreadId = ThreadId.makeUnsafe("sentinel-worktree-thread");
    const activeTurnId = TurnId.makeUnsafe("active-local-turn");
    const sentinelCwd = "/repo/.worktrees/sentinel";
    const projectId = ProjectId.makeUnsafe("project-1");
    const harness = await createHarness({
      threads: [
        {
          id: localThreadId,
          projectId,
          envMode: "local",
          worktreePath: null,
          branch: "synara/stale-branch",
          lastKnownPr: null,
        },
        {
          id: sentinelThreadId,
          projectId,
          envMode: "worktree",
          worktreePath: sentinelCwd,
          branch: "synara/stale-sentinel",
          lastKnownPr: null,
        },
      ],
      branchByCwd: {
        "/repo": pullRequest.headBranch,
        [sentinelCwd]: pullRequest.headBranch,
      },
    });

    await harness.publish(startedEvent(localThreadId, activeTurnId));
    await harness.publish(completedEvent(localThreadId, TurnId.makeUnsafe("stale-local-turn")));
    await harness.publish(
      completedEvent(sentinelThreadId, TurnId.makeUnsafe("sentinel-worktree-turn")),
    );
    await waitFor(() => harness.reconciliations.length === 1);
    await harness.drain();

    expect(harness.reconciliations[0]).toMatchObject({
      threadId: sentinelThreadId,
    });
    expect(harness.statusCwds).toEqual([sentinelCwd]);

    await harness.publish(completedEvent(localThreadId, activeTurnId));
    await waitFor(() => harness.reconciliations.length === 2);
    await harness.drain();
    expect(harness.reconciliations[1]).toMatchObject({
      threadId: localThreadId,
      branch: pullRequest.headBranch,
    });
  });

  it("skips overlapping shared turns and resumes on the next exclusive owner", async () => {
    const firstThreadId = ThreadId.makeUnsafe("first-local-thread");
    const secondThreadId = ThreadId.makeUnsafe("second-local-thread");
    const thirdThreadId = ThreadId.makeUnsafe("third-local-thread");
    const firstTurnId = TurnId.makeUnsafe("first-local-turn");
    const secondTurnId = TurnId.makeUnsafe("second-local-turn");
    const projectId = ProjectId.makeUnsafe("project-1");
    const harness = await createHarness({
      threads: [firstThreadId, secondThreadId, thirdThreadId].map((id) => ({
        id,
        projectId,
        envMode: "local" as const,
        worktreePath: null,
        branch: "synara/stale-branch",
        lastKnownPr: null,
      })),
      branchByCwd: { "/repo": pullRequest.headBranch },
    });

    await harness.publish(startedEvent(firstThreadId, firstTurnId));
    await harness.publish(startedEvent(secondThreadId, secondTurnId));
    await harness.publish(completedEvent(firstThreadId, firstTurnId));
    await harness.publish(completedEvent(secondThreadId, secondTurnId));
    const thirdTurnId = TurnId.makeUnsafe("third-local-turn");
    await harness.publish(startedEvent(thirdThreadId, thirdTurnId));
    await harness.publish(completedEvent(thirdThreadId, thirdTurnId));
    await waitFor(() => harness.reconciliations.length === 1);
    await harness.drain();

    expect(harness.reconciliations[0]).toMatchObject({
      threadId: thirdThreadId,
    });
  });

  it("preserves matching durable metadata when GitHub is temporarily unavailable", async () => {
    const threadId = ThreadId.makeUnsafe("worktree-offline-thread");
    const cwd = "/repo/.worktrees/offline";
    const harness = await createHarness({
      threads: [
        {
          id: threadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          envMode: "worktree",
          worktreePath: cwd,
          branch: pullRequest.headBranch,
          lastKnownPr: pullRequest,
          associatedWorktreePath: cwd,
          associatedWorktreeBranch: pullRequest.headBranch,
          associatedWorktreeRef: pullRequest.headBranch,
        },
      ],
      branchByCwd: { [cwd]: pullRequest.headBranch },
      pullRequestLookupFails: true,
    });

    await harness.publish(completedEvent(threadId, TurnId.makeUnsafe("offline-turn")));
    await waitFor(() => harness.pullRequestLookups.length === 1);
    await harness.drain();

    expect(harness.reconciliations).toEqual([]);
  });

  it("keeps an associated PR when a shared checkout is back on a branch without one", async () => {
    const threadId = ThreadId.makeUnsafe("local-associated-thread");
    const turnId = TurnId.makeUnsafe("local-associated-turn");
    const harness = await createHarness({
      threads: [
        {
          id: threadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          envMode: "local",
          worktreePath: null,
          branch: "main",
          lastKnownPr: pullRequest,
        },
      ],
      branchByCwd: { "/repo": "main" },
    });

    await harness.publish(startedEvent(threadId, turnId));
    await harness.publish(completedEvent(threadId, turnId));
    await waitFor(() => harness.pullRequestLookups.length === 1);
    await harness.drain();

    expect(harness.pullRequestLookups).toEqual(["main"]);
    expect(harness.reconciliations).toEqual([]);
  });

  it.each(["commit", "code_change_published"])(
    "refreshes actual worktree metadata mid-turn after %s",
    async (kind) => {
      const threadId = ThreadId.makeUnsafe("vcs-worktree-thread");
      const cwd = "/repo/.worktrees/vcs";
      const harness = await createHarness({
        threads: [
          {
            id: threadId,
            projectId: ProjectId.makeUnsafe("project-1"),
            envMode: "worktree",
            worktreePath: cwd,
            branch: "synara/stale-branch",
            lastKnownPr: null,
          },
        ],
        branchByCwd: { [cwd]: pullRequest.headBranch },
      });

      await harness.publish(startedEvent(threadId, TurnId.makeUnsafe("vcs-running-turn")));
      await harness.publish(
        vcsStateChangedEvent(threadId, {
          kind,
          ...(kind === "commit" ? { cwd } : {}),
        }),
      );
      await waitFor(() => harness.reconciliations.length === 1);
      await harness.drain();

      expect(harness.statusCwds).toEqual([cwd]);
      expect(harness.pullRequestLookups).toEqual([pullRequest.headBranch]);
      expect(harness.reconciliations[0]).toMatchObject({
        threadId,
        branch: pullRequest.headBranch,
        discoveredPullRequest: pullRequest,
        associatedWorktreeBranch: pullRequest.headBranch,
      });
    },
  );

  it("ignores VCS state changes reported for a different workspace", async () => {
    const threadId = ThreadId.makeUnsafe("vcs-mismatch-thread");
    const cwd = "/repo/.worktrees/vcs-mismatch";
    const harness = await createHarness({
      threads: [
        {
          id: threadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          envMode: "worktree",
          worktreePath: cwd,
          branch: "synara/stale-branch",
          lastKnownPr: null,
        },
      ],
      branchByCwd: { [cwd]: pullRequest.headBranch },
    });

    await harness.publish(
      vcsStateChangedEvent(threadId, { cwd: "/elsewhere", eventId: "vcs-elsewhere" }),
    );
    await harness.publish(vcsStateChangedEvent(threadId, { cwd }));
    await waitFor(() => harness.reconciliations.length === 1);
    await harness.drain();

    expect(harness.statusCwds).toEqual([cwd]);
    expect(harness.reconciliations[0]).toMatchObject({
      threadId,
      branch: pullRequest.headBranch,
    });
  });

  it("only applies shared-checkout VCS changes for the sole active owning thread", async () => {
    const firstThreadId = ThreadId.makeUnsafe("vcs-first-local-thread");
    const secondThreadId = ThreadId.makeUnsafe("vcs-second-local-thread");
    const sentinelThreadId = ThreadId.makeUnsafe("vcs-sentinel-worktree-thread");
    const sentinelCwd = "/repo/.worktrees/vcs-sentinel";
    const projectId = ProjectId.makeUnsafe("project-1");
    const harness = await createHarness({
      threads: [
        ...[firstThreadId, secondThreadId].map((id) => ({
          id,
          projectId,
          envMode: "local" as const,
          worktreePath: null,
          branch: "synara/stale-branch",
          lastKnownPr: null,
        })),
        {
          id: sentinelThreadId,
          projectId,
          envMode: "worktree" as const,
          worktreePath: sentinelCwd,
          branch: "synara/stale-sentinel",
          lastKnownPr: null,
        },
      ],
      branchByCwd: {
        "/repo": pullRequest.headBranch,
        [sentinelCwd]: pullRequest.headBranch,
      },
    });

    await harness.publish(startedEvent(firstThreadId, TurnId.makeUnsafe("vcs-first-turn")));
    await harness.publish(vcsStateChangedEvent(firstThreadId, { cwd: "/repo" }));
    await waitFor(() => harness.reconciliations.length === 1);
    await harness.drain();
    expect(harness.reconciliations[0]).toMatchObject({
      threadId: firstThreadId,
      branch: pullRequest.headBranch,
    });

    await harness.publish(startedEvent(secondThreadId, TurnId.makeUnsafe("vcs-second-turn")));
    await harness.publish(
      vcsStateChangedEvent(secondThreadId, { cwd: "/repo", eventId: "vcs-ambiguous" }),
    );
    await harness.publish(completedEvent(sentinelThreadId, TurnId.makeUnsafe("vcs-sentinel-turn")));
    await waitFor(() => harness.reconciliations.length === 2);
    await harness.drain();

    expect(harness.statusCwds).toEqual(["/repo", sentinelCwd]);
    expect(harness.reconciliations[1]).toMatchObject({
      threadId: sentinelThreadId,
    });
  });

  it("releases ambiguous local turn ownership when the provider runtime exits", async () => {
    const staleThreadId = ThreadId.makeUnsafe("stale-local-thread");
    const nextThreadId = ThreadId.makeUnsafe("next-local-thread");
    const projectId = ProjectId.makeUnsafe("project-1");
    const harness = await createHarness({
      threads: [staleThreadId, nextThreadId].map((id) => ({
        id,
        projectId,
        envMode: "local" as const,
        worktreePath: null,
        branch: "synara/stale-branch",
        lastKnownPr: null,
      })),
      branchByCwd: { "/repo": pullRequest.headBranch },
    });

    await harness.publish(startedEvent(staleThreadId, TurnId.makeUnsafe("stale-turn-1")));
    await harness.publish(startedEvent(staleThreadId, TurnId.makeUnsafe("stale-turn-2")));
    await harness.publish(runtimeErrorEvent(staleThreadId));
    await harness.publish(startedEvent(nextThreadId, TurnId.makeUnsafe("next-turn")));
    await harness.publish(completedEvent(nextThreadId, TurnId.makeUnsafe("next-turn")));
    await waitFor(() => harness.reconciliations.length === 1);
    await harness.drain();

    expect(harness.reconciliations[0]).toMatchObject({
      threadId: nextThreadId,
      branch: pullRequest.headBranch,
    });
  });

  it("dispatches the workspace patch and the discovered PR as separate commands", async () => {
    const threadId = ThreadId.makeUnsafe("split-worktree-thread");
    const cwd = "/repo/.worktrees/split";
    const harness = await createHarness({
      threads: [
        {
          id: threadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          envMode: "worktree",
          worktreePath: cwd,
          branch: "synara/stale-branch",
          lastKnownPr: null,
        },
      ],
      branchByCwd: { [cwd]: pullRequest.headBranch },
    });

    await harness.publish(completedEvent(threadId, TurnId.makeUnsafe("split-turn")));
    await waitFor(() => harness.commands.length === 2);
    await harness.drain();

    expect(harness.commands[0]).toMatchObject({
      type: "thread.meta.update",
      threadId,
      branch: pullRequest.headBranch,
    });
    expect(harness.commands[0]).not.toHaveProperty("lastKnownPr");
    expect(harness.commands[1]).toMatchObject({
      type: "thread.pull-request.sync",
      threadId,
      discovered: pullRequest,
    });
  });

  it("keeps an explicitly linked PR when the worktree moves to a branch without one", async () => {
    const threadId = ThreadId.makeUnsafe("explicit-link-thread");
    const cwd = "/repo/.worktrees/explicit";
    const harness = await createHarness({
      threads: [
        {
          id: threadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          envMode: "worktree",
          worktreePath: cwd,
          branch: pullRequest.headBranch,
          lastKnownPr: pullRequest,
          pullRequests: [{ pullRequest, source: "agent", linkedAt: "2026-08-07T09:30:00.000Z" }],
          associatedWorktreePath: cwd,
          associatedWorktreeBranch: pullRequest.headBranch,
          associatedWorktreeRef: pullRequest.headBranch,
        },
      ],
      branchByCwd: { [cwd]: "main" },
    });

    await harness.publish(completedEvent(threadId, TurnId.makeUnsafe("explicit-turn")));
    await waitFor(() => harness.commands.length === 1);
    await harness.drain();

    expect(harness.commands.map((command) => command.type)).toEqual(["thread.meta.update"]);
    expect(harness.threads.get(threadId)?.lastKnownPr).toEqual(pullRequest);
  });

  const commandCompletedEvent = (
    threadId: ThreadId,
    itemId: string,
    command: string,
    output: string,
  ): ProviderRuntimeEvent =>
    ({
      type: "item.completed",
      eventId: EventId.makeUnsafe(`item-${itemId}`),
      provider: "codex",
      threadId,
      turnId: TurnId.makeUnsafe("command-turn"),
      itemId,
      createdAt: "2026-08-07T10:00:30.000Z",
      payload: {
        itemType: "command_execution",
        status: "completed",
        data: { item: { command, aggregatedOutput: output } },
      },
    }) as unknown as ProviderRuntimeEvent;

  it.each(["unlinked", "discovered"] as const)(
    "keeps a command-created pull request attached after its branch changes (%s)",
    async (initialLink) => {
      const threadId = ThreadId.makeUnsafe("command-created-thread");
      const createdUrl = "https://github.com/Emanuele-web04/synara/pull/601";
      const harness = await createHarness({
        threads: [
          {
            id: threadId,
            projectId: ProjectId.makeUnsafe("project-1"),
            envMode: "local",
            worktreePath: null,
            branch: "feat/thing",
            lastKnownPr: null,
            pullRequests:
              initialLink === "discovered"
                ? [
                    {
                      pullRequest: { ...pullRequest, url: createdUrl },
                      source: "discovered",
                      linkedAt: "2026-08-07T09:00:00.000Z",
                    },
                  ]
                : [],
          },
        ],
        branchByCwd: { "/repo": "feat/thing" },
      });

      await harness.publish(
        commandCompletedEvent(
          threadId,
          "item-create",
          'bash -lc \'gh pr create --title "Thing" --body "Body"\'',
          `Creating pull request for feat/thing into main\n\n${createdUrl}\n`,
        ),
      );
      await waitFor(() => harness.commands.length === 1);
      await harness.drain();

      expect(harness.resolvedPullRequestReferences).toEqual([createdUrl]);
      expect(harness.commands[0]).toMatchObject({
        type: "thread.pull-request.link",
        threadId,
        source: "created",
        pullRequest: { url: createdUrl },
      });
      // Discovery clears branch-managed links when the checkout moves to another branch.
      expect(
        syncDiscoveredPullRequest(
          harness.threads.get(threadId)?.pullRequests,
          null,
          "2026-08-07T10:05:00.000Z",
        ),
      ).toMatchObject([{ source: "created", pullRequest: { url: createdUrl } }]);
    },
  );

  it("does not re-link a pull request the user unlinked", async () => {
    const threadId = ThreadId.makeUnsafe("command-unlinked-thread");
    const createdUrl = "https://github.com/Emanuele-web04/synara/pull/602";
    const harness = await createHarness({
      threads: [
        {
          id: threadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          envMode: "local",
          worktreePath: null,
          branch: "feat/thing",
          lastKnownPr: null,
          pullRequests: [
            {
              pullRequest: { ...pullRequest, url: createdUrl, number: 602 },
              source: "created",
              linkedAt: "2026-08-07T09:30:00.000Z",
              dismissedAt: "2026-08-07T09:40:00.000Z",
            },
          ],
        },
      ],
      branchByCwd: { "/repo": "feat/thing" },
    });

    await harness.publish(
      commandCompletedEvent(threadId, "item-recreate", "gh pr create --fill", `${createdUrl}\n`),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await harness.drain();

    expect(harness.resolvedPullRequestReferences).toEqual([]);
    expect(harness.commands).toEqual([]);
  });
});
