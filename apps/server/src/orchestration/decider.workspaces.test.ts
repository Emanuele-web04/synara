import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  WorktreeWorkspaceId,
  WorkspaceOperationId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const modelSelection = { provider: "codex" as const, model: "gpt-5.5" };

async function apply(
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
): Promise<OrchestrationReadModel> {
  let next = readModel;
  for (const [index, event] of events.entries()) {
    next = await Effect.runPromise(
      projectEvent(next, {
        ...event,
        sequence: readModel.snapshotSequence + index + 1,
        eventId: EventId.makeUnsafe(`workspace-event-${readModel.snapshotSequence + index + 1}`),
      } as OrchestrationEvent),
    );
  }
  return next;
}

async function repositoryProject(now: string) {
  const empty = createEmptyReadModel(now);
  const result = await Effect.runPromise(
    decideOrchestrationCommand({
      readModel: empty,
      command: {
        type: "project.create",
        commandId: CommandId.makeUnsafe("workspace-project-create"),
        projectId: ProjectId.makeUnsafe("workspace-project"),
        title: "Workspace project",
        workspaceRoot: "/tmp/workspace-project",
        repositoryIdentity: "repo:workspace-project",
        defaultTargetRef: "main",
        createdAt: now,
      },
    }),
  );
  return apply(empty, Array.isArray(result) ? result : [result]);
}

describe("worktree workspace commands", () => {
  it("atomically creates a workspace and its first conversation", async () => {
    const now = new Date().toISOString();
    const readModel = await repositoryProject(now);
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.create",
          commandId: CommandId.makeUnsafe("workspace-create"),
          workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-1"),
          threadId: ThreadId.makeUnsafe("workspace-thread-1"),
          projectId: ProjectId.makeUnsafe("workspace-project"),
          operationId: WorkspaceOperationId.makeUnsafe("workspace-operation-1"),
          title: "Feature workspace",
          targetRef: "main",
          branch: "amir/feature-workspace",
          sourceRef: "main",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual(["workspace.created", "thread.created"]);
    expect(events[0]?.payload).toMatchObject({
      branch: "amir/feature-workspace",
      sourceRef: "main",
      targetRef: "main",
    });
    expect(events[1]?.payload).toMatchObject({
      workspaceId: "workspace-1",
      worktreePath: null,
    });
  });

  it("reserves canonical pull-request identity before provisioning", async () => {
    const now = new Date().toISOString();
    const initial = await repositoryProject(now);
    const pullRequest = {
      number: 42,
      title: "Review workspace lifecycle",
      url: "https://github.com/Acme/Repo/pull/42",
      baseBranch: "develop",
      headBranch: "feature/review-lifecycle",
      state: "open" as const,
    };
    const createPullRequestWorkspace = (suffix: string, url: string) =>
      decideOrchestrationCommand({
        readModel: initial,
        command: {
          type: "workspace.create",
          commandId: CommandId.makeUnsafe(`workspace-pr-create-${suffix}`),
          workspaceId: WorktreeWorkspaceId.makeUnsafe(`workspace-pr-${suffix}`),
          threadId: ThreadId.makeUnsafe(`thread-pr-${suffix}`),
          projectId: ProjectId.makeUnsafe("workspace-project"),
          operationId: WorkspaceOperationId.makeUnsafe(`operation-pr-${suffix}`),
          title: pullRequest.title,
          targetRef: "stale-caller-base",
          sourceKind: "pull-request",
          sourceRef: url,
          lastKnownPr: { ...pullRequest, url },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      });

    const created = await Effect.runPromise(createPullRequestWorkspace("first", pullRequest.url));
    const events = Array.isArray(created) ? created : [created];
    expect(events[0]?.payload).toMatchObject({
      sourceKind: "pull-request",
      sourceRef: pullRequest.url,
      targetRef: "develop",
      branch: "feature/review-lifecycle",
      lastKnownPr: { number: 42, url: pullRequest.url },
    });
    expect(events[1]?.payload).toMatchObject({
      workspaceId: "workspace-pr-first",
      lastKnownPr: { number: 42, url: pullRequest.url },
    });

    const activeModel = await apply(initial, events);
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: activeModel,
          command: {
            type: "workspace.create",
            commandId: CommandId.makeUnsafe("workspace-pr-create-duplicate"),
            workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-pr-duplicate"),
            threadId: ThreadId.makeUnsafe("thread-pr-duplicate"),
            projectId: ProjectId.makeUnsafe("workspace-project"),
            operationId: WorkspaceOperationId.makeUnsafe("operation-pr-duplicate"),
            title: pullRequest.title,
            targetRef: "develop",
            sourceKind: "pull-request",
            sourceRef: "https://github.com/acme/repo/pull/42/files",
            lastKnownPr: {
              ...pullRequest,
              url: "https://github.com/acme/repo/pull/42/",
            },
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          },
        }),
      ),
    ).rejects.toThrow("already attached to workspace 'workspace-pr-first'");

    const archivedModel: OrchestrationReadModel = {
      ...activeModel,
      workspaces: activeModel.workspaces?.map((workspace) =>
        workspace.id === WorktreeWorkspaceId.makeUnsafe("workspace-pr-first")
          ? { ...workspace, state: "archived" as const, archivedAt: now }
          : workspace,
      ),
    };
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: archivedModel,
          command: {
            type: "workspace.create",
            commandId: CommandId.makeUnsafe("workspace-pr-create-archived-duplicate"),
            workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-pr-archived-duplicate"),
            threadId: ThreadId.makeUnsafe("thread-pr-archived-duplicate"),
            projectId: ProjectId.makeUnsafe("workspace-project"),
            operationId: WorkspaceOperationId.makeUnsafe("operation-pr-archived-duplicate"),
            title: pullRequest.title,
            targetRef: "develop",
            sourceKind: "pull-request",
            sourceRef: "https://github.com/acme/repo/pull/42",
            lastKnownPr: {
              ...pullRequest,
              url: "https://github.com/acme/repo/pull/42",
            },
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          },
        }),
      ),
    ).rejects.toThrow("belongs to archived workspace 'workspace-pr-first'");
  });

  it("persists refreshed pull-request refs with provisioning completion", async () => {
    const now = new Date().toISOString();
    const initial = await repositoryProject(now);
    const created = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: initial,
        command: {
          type: "workspace.create",
          commandId: CommandId.makeUnsafe("workspace-pr-refresh-create"),
          workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-pr-refresh"),
          threadId: ThreadId.makeUnsafe("thread-pr-refresh"),
          projectId: ProjectId.makeUnsafe("workspace-project"),
          operationId: WorkspaceOperationId.makeUnsafe("operation-pr-refresh"),
          title: "Refresh PR",
          targetRef: "main",
          sourceKind: "pull-request",
          sourceRef: "https://github.com/acme/repo/pull/84",
          lastKnownPr: {
            number: 84,
            title: "Refresh PR",
            url: "https://github.com/acme/repo/pull/84",
            baseBranch: "main",
            headBranch: "feature/old-head",
            state: "open",
          },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }),
    );
    const readModel = await apply(initial, Array.isArray(created) ? created : [created]);
    const completed = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.provision.complete",
          commandId: CommandId.makeUnsafe("workspace-pr-refresh-complete"),
          workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-pr-refresh"),
          operationId: WorkspaceOperationId.makeUnsafe("operation-pr-refresh"),
          generation: 1,
          path: "/tmp/workspaces/workspace-pr-refresh",
          branch: "synara/pr-84/fork-head",
          headRef: "head123",
          targetResolvedCommit: "base123",
          createdFromCommit: "head123",
          targetRef: "develop",
          lastKnownPr: {
            number: 84,
            title: "Refresh PR",
            url: "https://github.com/ACME/repo/pull/84/",
            baseBranch: "develop",
            headBranch: "fork-head",
            state: "open",
          },
          setupStatus: "skipped",
          completedAt: now,
        },
      }),
    );
    const completionEvents = Array.isArray(completed) ? completed : [completed];
    expect(completionEvents.map((event) => event.type)).toEqual([
      "workspace.ready",
      "workspace.meta-updated",
    ]);
    const completedModel = await apply(readModel, completionEvents);
    expect(completedModel.workspaces?.[0]).toMatchObject({
      state: "ready",
      path: "/tmp/workspaces/workspace-pr-refresh",
      branch: "synara/pr-84/fork-head",
      targetRef: "develop",
      lastKnownPr: { number: 84, baseBranch: "develop", headBranch: "fork-head" },
    });
    expect(completedModel.threads[0]).toMatchObject({
      branch: "synara/pr-84/fork-head",
      worktreePath: "/tmp/workspaces/workspace-pr-refresh",
      lastKnownPr: { number: 84, baseBranch: "develop", headBranch: "fork-head" },
    });
  });

  it("adds another conversation without emitting a workspace lifecycle event", async () => {
    const now = new Date().toISOString();
    const initial = await repositoryProject(now);
    const created = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: initial,
        command: {
          type: "workspace.create",
          commandId: CommandId.makeUnsafe("workspace-create-for-sibling"),
          workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-sibling"),
          threadId: ThreadId.makeUnsafe("workspace-thread-first"),
          projectId: ProjectId.makeUnsafe("workspace-project"),
          operationId: WorkspaceOperationId.makeUnsafe("workspace-operation-sibling"),
          title: "Sibling workspace",
          targetRef: "main",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }),
    );
    const readModel = await apply(initial, Array.isArray(created) ? created : [created]);
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.conversation.create",
          commandId: CommandId.makeUnsafe("workspace-add-conversation"),
          workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-sibling"),
          threadId: ThreadId.makeUnsafe("workspace-thread-second"),
          title: "Second conversation",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }),
    );

    expect(Array.isArray(result)).toBe(false);
    const event = (Array.isArray(result) ? result[0] : result) as Omit<
      OrchestrationEvent,
      "sequence"
    >;
    expect(event.type).toBe("thread.created");
    expect(event.payload).toMatchObject({ workspaceId: "workspace-sibling" });
  });

  it("attaches an existing pull-request worktree and updates its display metadata", async () => {
    const now = new Date().toISOString();
    const initial = await repositoryProject(now);
    const attached = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: initial,
        command: {
          type: "workspace.attach",
          commandId: CommandId.makeUnsafe("workspace-attach-pr"),
          workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-pr"),
          threadId: ThreadId.makeUnsafe("workspace-pr-thread"),
          projectId: ProjectId.makeUnsafe("workspace-project"),
          title: "Review checkout",
          path: "/tmp/workspace-pr",
          branch: "feature/review",
          headRef: null,
          targetRef: "main",
          sourceKind: "pull-request",
          sourceRef: "https://github.com/example/repo/pull/42",
          lastKnownPr: {
            number: 42,
            title: "Review checkout",
            url: "https://github.com/example/repo/pull/42",
            baseBranch: "main",
            headBranch: "feature/review",
            state: "open",
          },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }),
    );
    const readModel = await apply(initial, Array.isArray(attached) ? attached : [attached]);
    const sibling = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.conversation.create",
          commandId: CommandId.makeUnsafe("workspace-pr-sibling"),
          workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-pr"),
          threadId: ThreadId.makeUnsafe("workspace-pr-thread-2"),
          title: "Review follow-up",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }),
    );
    const siblingEvent = (Array.isArray(sibling) ? sibling[0] : sibling) as Omit<
      OrchestrationEvent,
      "sequence"
    >;
    expect(siblingEvent.payload).toMatchObject({
      workspaceId: "workspace-pr",
      lastKnownPr: {
        number: 42,
        url: "https://github.com/example/repo/pull/42",
      },
    });
    const readModelWithSibling = await apply(
      readModel,
      Array.isArray(sibling) ? sibling : [sibling],
    );
    const renamed = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: readModelWithSibling,
        command: {
          type: "workspace.meta.update",
          commandId: CommandId.makeUnsafe("workspace-rename"),
          workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-pr"),
          title: "Shipping details",
          branch: "feature/shipping-details",
          targetRef: "develop",
          lastKnownPr: {
            number: 42,
            title: "Shipping details",
            url: "https://github.com/example/repo/pull/42",
            baseBranch: "develop",
            headBranch: "feature/shipping-details",
            state: "merged",
          },
          isPinned: true,
          updatedAt: now,
        },
      }),
    );
    const finalModel = await apply(
      readModelWithSibling,
      Array.isArray(renamed) ? renamed : [renamed],
    );

    expect(finalModel.workspaces?.[0]).toMatchObject({
      title: "Shipping details",
      branch: "feature/shipping-details",
      targetRef: "develop",
      sourceKind: "pull-request",
      isPinned: true,
      mutationRevision: 1,
      lastKnownPr: { number: 42, state: "merged" },
    });
    expect(finalModel.threads).toHaveLength(2);
    for (const thread of finalModel.threads) {
      expect(thread).toMatchObject({
        workspaceId: "workspace-pr",
        branch: "feature/shipping-details",
        lastKnownPr: { number: 42, state: "merged" },
      });
    }

    const unlinked = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: finalModel,
        command: {
          type: "workspace.meta.update",
          commandId: CommandId.makeUnsafe("workspace-unlink-pr"),
          workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-pr"),
          lastKnownPr: null,
          updatedAt: now,
        },
      }),
    );
    const unlinkedModel = await apply(finalModel, Array.isArray(unlinked) ? unlinked : [unlinked]);
    expect(unlinkedModel.workspaces?.[0]?.lastKnownPr).toBeNull();
    expect(unlinkedModel.threads.every((thread) => thread.lastKnownPr === null)).toBe(true);
  });

  it("rejects a second active workspace for the same canonical pull request", async () => {
    const now = new Date().toISOString();
    const initial = await repositoryProject(now);
    const makeAttach = (suffix: string, url: string) => ({
      type: "workspace.attach" as const,
      commandId: CommandId.makeUnsafe(`workspace-attach-${suffix}`),
      workspaceId: WorktreeWorkspaceId.makeUnsafe(`workspace-${suffix}`),
      threadId: ThreadId.makeUnsafe(`thread-${suffix}`),
      projectId: ProjectId.makeUnsafe("workspace-project"),
      title: `Review ${suffix}`,
      path: `/tmp/workspace-${suffix}`,
      branch: `feature/${suffix}`,
      headRef: null,
      targetRef: "main",
      sourceKind: "pull-request" as const,
      sourceRef: url,
      lastKnownPr: {
        number: 42,
        title: `Review ${suffix}`,
        url,
        baseBranch: "main",
        headBranch: `feature/${suffix}`,
        state: "open" as const,
      },
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      createdAt: now,
    });
    const first = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: initial,
        command: makeAttach("first", "https://github.com/Acme/Repo/pull/42"),
      }),
    );
    const readModel = await apply(initial, Array.isArray(first) ? first : [first]);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: makeAttach("second", "https://github.com/acme/repo/pull/42/"),
        }),
      ),
    ).rejects.toThrow("already attached to workspace 'workspace-first'");
  });

  it("rejects duplicate pull-request workspaces identified only by canonical source refs", async () => {
    const now = new Date().toISOString();
    const initial = await repositoryProject(now);
    const makeAttach = (suffix: string, url: string) => ({
      type: "workspace.attach" as const,
      commandId: CommandId.makeUnsafe(`workspace-source-attach-${suffix}`),
      workspaceId: WorktreeWorkspaceId.makeUnsafe(`workspace-source-${suffix}`),
      threadId: ThreadId.makeUnsafe(`thread-source-${suffix}`),
      projectId: ProjectId.makeUnsafe("workspace-project"),
      title: `Source review ${suffix}`,
      path: `/tmp/workspace-source-${suffix}`,
      branch: `feature/source-${suffix}`,
      headRef: null,
      targetRef: "main",
      sourceKind: "pull-request" as const,
      sourceRef: url,
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      createdAt: now,
    });
    const first = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: initial,
        command: makeAttach("first", "https://github.com/Acme/Repo/pull/42"),
      }),
    );
    const readModel = await apply(initial, Array.isArray(first) ? first : [first]);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: makeAttach("second", "https://github.com/acme/repo/pull/42/files"),
        }),
      ),
    ).rejects.toThrow("already attached to workspace 'workspace-source-first'");
  });

  it("rejects metadata association when another workspace source ref owns the pull request", async () => {
    const now = new Date().toISOString();
    const initial = await repositoryProject(now);
    const attach = (input: {
      readonly suffix: string;
      readonly sourceKind: "branch" | "pull-request";
      readonly sourceRef: string;
    }) =>
      decideOrchestrationCommand({
        readModel: initial,
        command: {
          type: "workspace.attach",
          commandId: CommandId.makeUnsafe(`workspace-meta-attach-${input.suffix}`),
          workspaceId: WorktreeWorkspaceId.makeUnsafe(`workspace-meta-${input.suffix}`),
          threadId: ThreadId.makeUnsafe(`thread-meta-${input.suffix}`),
          projectId: ProjectId.makeUnsafe("workspace-project"),
          title: `Metadata ${input.suffix}`,
          path: `/tmp/workspace-meta-${input.suffix}`,
          branch: `feature/meta-${input.suffix}`,
          headRef: null,
          targetRef: "main",
          sourceKind: input.sourceKind,
          sourceRef: input.sourceRef,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      });
    const first = await Effect.runPromise(
      attach({
        suffix: "owner",
        sourceKind: "pull-request",
        sourceRef: "https://github.com/Acme/Repo/pull/42",
      }),
    );
    let readModel = await apply(initial, Array.isArray(first) ? first : [first]);
    const second = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.attach",
          commandId: CommandId.makeUnsafe("workspace-meta-attach-candidate"),
          workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-meta-candidate"),
          threadId: ThreadId.makeUnsafe("thread-meta-candidate"),
          projectId: ProjectId.makeUnsafe("workspace-project"),
          title: "Metadata candidate",
          path: "/tmp/workspace-meta-candidate",
          branch: "feature/meta-candidate",
          headRef: null,
          targetRef: "main",
          sourceKind: "branch",
          sourceRef: "feature/meta-candidate",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }),
    );
    readModel = await apply(readModel, Array.isArray(second) ? second : [second]);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "workspace.meta.update",
            commandId: CommandId.makeUnsafe("workspace-meta-link-candidate"),
            workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-meta-candidate"),
            lastKnownPr: {
              number: 42,
              title: "Canonical PR",
              url: "https://github.com/acme/repo/pull/42/",
              baseBranch: "main",
              headBranch: "feature/meta-candidate",
              state: "open",
            },
            updatedAt: now,
          },
        }),
      ),
    ).rejects.toThrow("already attached to workspace 'workspace-meta-owner'");
  });

  it("rejects a stale provisioning completion generation", async () => {
    const now = new Date().toISOString();
    const initial = await repositoryProject(now);
    const created = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: initial,
        command: {
          type: "workspace.create",
          commandId: CommandId.makeUnsafe("workspace-create-for-fence"),
          workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-fence"),
          threadId: ThreadId.makeUnsafe("workspace-thread-fence"),
          projectId: ProjectId.makeUnsafe("workspace-project"),
          operationId: WorkspaceOperationId.makeUnsafe("workspace-operation-fence"),
          title: "Fenced workspace",
          targetRef: "main",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }),
    );
    const readModel = await apply(initial, Array.isArray(created) ? created : [created]);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "workspace.provision.complete",
            commandId: CommandId.makeUnsafe("workspace-stale-completion"),
            workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-fence"),
            operationId: WorkspaceOperationId.makeUnsafe("workspace-operation-fence"),
            generation: 2,
            path: "/tmp/workspace-fence",
            branch: "synara/workspace-fence",
            headRef: "abc123",
            targetResolvedCommit: "abc123",
            createdFromCommit: "abc123",
            setupStatus: "skipped",
            completedAt: now,
          },
        }),
      ),
    ).rejects.toThrow(/Stale workspace completion/);
  });

  it("generation-fences a durable retry after pull-request provisioning fails", async () => {
    const now = new Date().toISOString();
    const initial = await repositoryProject(now);
    const workspaceId = WorktreeWorkspaceId.makeUnsafe("workspace-pr-retry");
    const firstOperationId = WorkspaceOperationId.makeUnsafe("workspace-pr-retry-first");
    const pullRequest = {
      number: 42,
      title: "Retry durable PR workspace",
      url: "https://github.com/acme/repo/pull/42",
      baseBranch: "release",
      headBranch: "feature/pr-retry",
      state: "open" as const,
    };
    const created = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: initial,
        command: {
          type: "workspace.create",
          commandId: CommandId.makeUnsafe("workspace-pr-retry-create"),
          workspaceId,
          threadId: ThreadId.makeUnsafe("thread-pr-retry"),
          projectId: ProjectId.makeUnsafe("workspace-project"),
          operationId: firstOperationId,
          title: pullRequest.title,
          targetRef: pullRequest.baseBranch,
          branch: pullRequest.headBranch,
          sourceKind: "pull-request",
          sourceRef: pullRequest.url,
          lastKnownPr: pullRequest,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }),
    );
    let readModel = await apply(initial, Array.isArray(created) ? created : [created]);
    const failed = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.operation.fail",
          commandId: CommandId.makeUnsafe("workspace-pr-retry-failed"),
          workspaceId,
          operationId: firstOperationId,
          generation: 1,
          kind: "provision",
          stage: "resolve-target",
          summary: "base was not available",
          failedAt: now,
        },
      }),
    );
    readModel = await apply(readModel, Array.isArray(failed) ? failed : [failed]);
    expect(readModel.workspaces?.find((workspace) => workspace.id === workspaceId)).toMatchObject({
      state: "error",
      lifecycleGeneration: 1,
      activeOperation: null,
      lastKnownPr: { number: 42 },
    });
    expect(readModel.threads.filter((thread) => thread.workspaceId === workspaceId)).toHaveLength(
      1,
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "workspace.provision.request",
            commandId: CommandId.makeUnsafe("workspace-pr-retry-stale-generation"),
            workspaceId,
            operationId: WorkspaceOperationId.makeUnsafe(
              "workspace-pr-retry-stale-generation-operation",
            ),
            expectedGeneration: 0,
            requestedAt: now,
          },
        }),
      ),
    ).rejects.toThrow(/Stale provision request/);

    const retryOperationId = WorkspaceOperationId.makeUnsafe("workspace-pr-retry-second");
    const retried = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.provision.request",
          commandId: CommandId.makeUnsafe("workspace-pr-retry-request"),
          workspaceId,
          operationId: retryOperationId,
          expectedGeneration: 1,
          requestedAt: now,
        },
      }),
    );
    expect(retried).toMatchObject({
      type: "workspace.provision-requested",
      payload: { workspaceId, operationId: retryOperationId, generation: 2 },
    });
    const retriedModel = await apply(readModel, Array.isArray(retried) ? retried : [retried]);
    expect(
      retriedModel.workspaces?.find((workspace) => workspace.id === workspaceId),
    ).toMatchObject({
      state: "provisioning",
      lifecycleGeneration: 2,
      activeOperation: { id: retryOperationId, generation: 2, kind: "provision" },
      lastFailure: null,
      lastKnownPr: { number: 42 },
    });
    expect(
      retriedModel.threads.filter((thread) => thread.workspaceId === workspaceId),
    ).toHaveLength(1);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: retriedModel,
          command: {
            type: "workspace.provision.request",
            commandId: CommandId.makeUnsafe("workspace-pr-retry-stale"),
            workspaceId,
            operationId: WorkspaceOperationId.makeUnsafe("workspace-pr-retry-stale-operation"),
            expectedGeneration: 1,
            requestedAt: now,
          },
        }),
      ),
    ).rejects.toThrow(/cannot retry pull request provisioning while provisioning/);
  });

  it("generation-fences a durable retry after pull-request setup fails", async () => {
    const now = new Date().toISOString();
    const initial = await repositoryProject(now);
    const workspaceId = WorktreeWorkspaceId.makeUnsafe("workspace-pr-setup-retry");
    const firstOperationId = WorkspaceOperationId.makeUnsafe("workspace-pr-setup-first");
    const created = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: initial,
        command: {
          type: "workspace.create",
          commandId: CommandId.makeUnsafe("workspace-pr-setup-create"),
          workspaceId,
          threadId: ThreadId.makeUnsafe("thread-pr-setup-retry"),
          projectId: ProjectId.makeUnsafe("workspace-project"),
          operationId: firstOperationId,
          title: "Retry setup for PR workspace",
          targetRef: "main",
          branch: "feature/setup-retry",
          sourceKind: "pull-request",
          sourceRef: "https://github.com/acme/repo/pull/43",
          lastKnownPr: {
            number: 43,
            title: "Retry setup for PR workspace",
            url: "https://github.com/acme/repo/pull/43",
            baseBranch: "main",
            headBranch: "feature/setup-retry",
            state: "open",
          },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }),
    );
    let readModel = await apply(initial, Array.isArray(created) ? created : [created]);
    const failed = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.operation.fail",
          commandId: CommandId.makeUnsafe("workspace-pr-setup-failed"),
          workspaceId,
          operationId: firstOperationId,
          generation: 1,
          kind: "setup",
          stage: "setup",
          summary: "bun install failed",
          path: "/repo-worktrees/workspace-pr-setup-retry",
          branch: "feature/setup-retry",
          headRef: "abc123",
          targetResolvedCommit: "abc123",
          createdFromCommit: "abc123",
          failedAt: now,
        },
      }),
    );
    readModel = await apply(readModel, Array.isArray(failed) ? failed : [failed]);
    expect(readModel.workspaces?.find((workspace) => workspace.id === workspaceId)).toMatchObject({
      state: "setup-failed",
      lifecycleGeneration: 1,
      setupStatus: "failed",
      activeOperation: null,
      path: "/repo-worktrees/workspace-pr-setup-retry",
      lastFailure: { kind: "setup", stage: "setup" },
    });

    const retryOperationId = WorkspaceOperationId.makeUnsafe("workspace-pr-setup-second");
    const retried = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.provision.request",
          commandId: CommandId.makeUnsafe("workspace-pr-setup-request"),
          workspaceId,
          operationId: retryOperationId,
          expectedGeneration: 1,
          requestedAt: now,
        },
      }),
    );
    const retriedModel = await apply(readModel, Array.isArray(retried) ? retried : [retried]);
    expect(
      retriedModel.workspaces?.find((workspace) => workspace.id === workspaceId),
    ).toMatchObject({
      state: "provisioning",
      lifecycleGeneration: 2,
      setupStatus: "pending",
      setupError: null,
      activeOperation: { id: retryOperationId, generation: 2, kind: "provision" },
      lastFailure: null,
      path: "/repo-worktrees/workspace-pr-setup-retry",
    });
    expect(
      retriedModel.threads.filter((thread) => thread.workspaceId === workspaceId),
    ).toHaveLength(1);
  });

  it("fences archive and restore transitions while retaining workspace metadata", async () => {
    const now = new Date().toISOString();
    const initial = await repositoryProject(now);
    const workspaceId = WorktreeWorkspaceId.makeUnsafe("workspace-lifecycle");
    const provisionOperationId = WorkspaceOperationId.makeUnsafe("workspace-lifecycle-provision");
    const created = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: initial,
        command: {
          type: "workspace.create",
          commandId: CommandId.makeUnsafe("workspace-lifecycle-create"),
          workspaceId,
          threadId: ThreadId.makeUnsafe("workspace-lifecycle-thread"),
          projectId: ProjectId.makeUnsafe("workspace-project"),
          operationId: provisionOperationId,
          title: "Lifecycle workspace",
          targetRef: "main",
          branch: "synara/lifecycle",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }),
    );
    let readModel = await apply(initial, Array.isArray(created) ? created : [created]);
    const ready = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.provision.complete",
          commandId: CommandId.makeUnsafe("workspace-lifecycle-ready"),
          workspaceId,
          operationId: provisionOperationId,
          generation: 1,
          path: "/tmp/workspace-lifecycle",
          branch: "synara/lifecycle",
          headRef: "abc123",
          targetResolvedCommit: "abc123",
          createdFromCommit: "abc123",
          setupStatus: "skipped",
          completedAt: now,
        },
      }),
    );
    readModel = await apply(readModel, Array.isArray(ready) ? ready : [ready]);

    const archiveOperationId = WorkspaceOperationId.makeUnsafe("workspace-lifecycle-archive");
    const archiveRequested = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.archive.request",
          commandId: CommandId.makeUnsafe("workspace-lifecycle-archive-request"),
          workspaceId,
          operationId: archiveOperationId,
          expectedGeneration: 1,
          confirmedWarnings: true,
          requestedAt: now,
        },
      }),
    );
    readModel = await apply(
      readModel,
      Array.isArray(archiveRequested) ? archiveRequested : [archiveRequested],
    );
    expect(readModel.workspaces?.[0]).toMatchObject({
      state: "archiving",
      lifecycleGeneration: 2,
      path: "/tmp/workspace-lifecycle",
      activeOperation: { kind: "archive", stage: "intent-confirmed" },
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "workspace.archive.complete",
            commandId: CommandId.makeUnsafe("workspace-lifecycle-stale-archive"),
            workspaceId,
            operationId: archiveOperationId,
            generation: 1,
            completedAt: now,
          },
        }),
      ),
    ).rejects.toThrow(/Stale archive completion/);

    const archived = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.archive.complete",
          commandId: CommandId.makeUnsafe("workspace-lifecycle-archived"),
          workspaceId,
          operationId: archiveOperationId,
          generation: 2,
          completedAt: now,
        },
      }),
    );
    readModel = await apply(readModel, Array.isArray(archived) ? archived : [archived]);
    expect(readModel.workspaces?.[0]).toMatchObject({
      state: "archived",
      path: "/tmp/workspace-lifecycle",
      branch: "synara/lifecycle",
      archivedAt: now,
    });
    expect(readModel.threads[0]?.worktreePath).toBeNull();

    const restoreOperationId = WorkspaceOperationId.makeUnsafe("workspace-lifecycle-restore");
    const restoreRequested = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.restore.request",
          commandId: CommandId.makeUnsafe("workspace-lifecycle-restore-request"),
          workspaceId,
          operationId: restoreOperationId,
          expectedGeneration: 2,
          requestedAt: now,
        },
      }),
    );
    readModel = await apply(
      readModel,
      Array.isArray(restoreRequested) ? restoreRequested : [restoreRequested],
    );
    const restored = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.restore.complete",
          commandId: CommandId.makeUnsafe("workspace-lifecycle-restored"),
          workspaceId,
          operationId: restoreOperationId,
          generation: 3,
          path: "/tmp/workspace-lifecycle",
          branch: "synara/lifecycle",
          headRef: "def456",
          setupStatus: "skipped",
          completedAt: now,
        },
      }),
    );
    readModel = await apply(readModel, Array.isArray(restored) ? restored : [restored]);
    expect(readModel.workspaces?.[0]).toMatchObject({
      state: "ready",
      lifecycleGeneration: 3,
      archivedAt: null,
      headRef: "def456",
    });
    expect(readModel.threads[0]).toMatchObject({
      worktreePath: "/tmp/workspace-lifecycle",
      associatedWorktreeRef: "def456",
      createBranchFlowCompleted: true,
    });
  });

  it("does not allow the repository root workspace to enter archive lifecycle", async () => {
    const now = new Date().toISOString();
    const readModel = await repositoryProject(now);
    const workspaceId = WorktreeWorkspaceId.makeUnsafe("workspace-root-lifecycle");
    const imported = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "workspace.import-legacy",
          commandId: CommandId.makeUnsafe("workspace-root-lifecycle-import"),
          workspaceId,
          projectId: ProjectId.makeUnsafe("workspace-project"),
          repositoryIdentity: "repo:workspace-project",
          kind: "repository-root",
          state: "ready",
          title: "Repository root",
          path: "/tmp/workspace-project",
          branch: "main",
          headRef: "abc123",
          targetRef: "main",
          targetResolvedCommit: "abc123",
          createdFromCommit: "abc123",
          setupStatus: "skipped",
          createdAt: now,
        },
      }),
    );
    const withRoot = await apply(readModel, Array.isArray(imported) ? imported : [imported]);
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: withRoot,
          command: {
            type: "workspace.archive.request",
            commandId: CommandId.makeUnsafe("workspace-root-lifecycle-archive"),
            workspaceId,
            operationId: WorkspaceOperationId.makeUnsafe("workspace-root-lifecycle-operation"),
            expectedGeneration: 0,
            requestedAt: now,
          },
        }),
      ),
    ).rejects.toThrow(/Repository root workspace/);
  });
});
