import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadPullRequest,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-pr-links");
const THREAD_ID = ThreadId.makeUnsafe("thread-pr-links");
const CREATED_AT = "2026-11-13T10:00:00.000Z";

const pr = (
  number: number,
  overrides: Partial<OrchestrationThreadPullRequest> = {},
): OrchestrationThreadPullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  baseBranch: "main",
  headBranch: `feat/${number}`,
  state: "open",
  ...overrides,
});

let sequence = 0;
const commandId = () => CommandId.makeUnsafe(`cmd-pr-links-${++sequence}`);

async function decide(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  const result = await Effect.runPromise(decideOrchestrationCommand({ readModel, command }));
  return (Array.isArray(result) ? result : [result]) as Array<Omit<OrchestrationEvent, "sequence">>;
}

async function apply(
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
): Promise<OrchestrationReadModel> {
  let next = readModel;
  for (const event of events) {
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence: ++sequence } as OrchestrationEvent),
    );
  }
  return next;
}

async function dispatch(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  const events = await decide(readModel, command);
  return { events, readModel: await apply(readModel, events) };
}

async function readModelWithThread(
  lastKnownPr: OrchestrationThreadPullRequest | null = null,
): Promise<OrchestrationReadModel> {
  const base = await apply(createEmptyReadModel(CREATED_AT), [
    {
      eventId: EventId.makeUnsafe("evt-pr-links-project"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: CREATED_AT,
      commandId: commandId(),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        kind: "project",
        title: "Repo",
        workspaceRoot: "/tmp/repo",
        defaultModelSelection: null,
        scripts: [],
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    } as Omit<OrchestrationEvent, "sequence">,
  ]);
  return (
    await dispatch(base, {
      type: "thread.create",
      commandId: commandId(),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "PR links",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      envMode: "local",
      branch: null,
      worktreePath: null,
      createBranchFlowCompleted: false,
      isPinned: false,
      parentThreadId: null,
      subagentAgentId: null,
      subagentNickname: null,
      subagentRole: null,
      lastKnownPr,
      createdAt: CREATED_AT,
    })
  ).readModel;
}

const threadOf = (readModel: OrchestrationReadModel) =>
  readModel.threads.find((thread) => thread.id === THREAD_ID)!;

describe("thread pull request links", () => {
  it("links several PRs and derives the current one", async () => {
    let readModel = await readModelWithThread();
    ({ readModel } = await dispatch(readModel, {
      type: "thread.pull-request.link",
      commandId: commandId(),
      threadId: THREAD_ID,
      pullRequest: pr(1),
      source: "agent",
    }));
    const { events, readModel: next } = await dispatch(readModel, {
      type: "thread.pull-request.link",
      commandId: commandId(),
      threadId: THREAD_ID,
      pullRequest: pr(2),
      source: "created",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "thread.meta-updated",
      payload: { lastKnownPr: pr(2) },
    });
    const thread = threadOf(next);
    expect(
      (thread.pullRequests ?? []).map((link) => [link.pullRequest.number, link.source]),
    ).toEqual([
      [1, "agent"],
      [2, "created"],
    ]);
    expect(thread.lastKnownPr).toEqual(pr(2));
  });

  it("does not append an event when a link or sync changes nothing", async () => {
    let readModel = await readModelWithThread();
    ({ readModel } = await dispatch(readModel, {
      type: "thread.pull-request.link",
      commandId: commandId(),
      threadId: THREAD_ID,
      pullRequest: pr(1),
      source: "agent",
    }));
    expect(
      await decide(readModel, {
        type: "thread.pull-request.link",
        commandId: commandId(),
        threadId: THREAD_ID,
        pullRequest: pr(1),
        source: "user",
      }),
    ).toEqual([]);
    expect(
      await decide(readModel, {
        type: "thread.pull-request.sync",
        commandId: commandId(),
        threadId: THREAD_ID,
        snapshots: [pr(1)],
      }),
    ).toEqual([]);
    expect(
      await decide(readModel, {
        type: "thread.pull-request.unlink",
        commandId: commandId(),
        threadId: THREAD_ID,
        url: pr(9).url,
      }),
    ).toEqual([]);
  });

  it("keeps explicit links when branch discovery clears and refreshes snapshots", async () => {
    let readModel = await readModelWithThread();
    ({ readModel } = await dispatch(readModel, {
      type: "thread.pull-request.link",
      commandId: commandId(),
      threadId: THREAD_ID,
      pullRequest: pr(1),
      source: "agent",
    }));
    ({ readModel } = await dispatch(readModel, {
      type: "thread.pull-request.sync",
      commandId: commandId(),
      threadId: THREAD_ID,
      discovered: pr(5),
    }));
    expect((threadOf(readModel).pullRequests ?? []).map((link) => link.source)).toEqual([
      "agent",
      "discovered",
    ]);

    ({ readModel } = await dispatch(readModel, {
      type: "thread.pull-request.sync",
      commandId: commandId(),
      threadId: THREAD_ID,
      discovered: null,
      snapshots: [pr(1, { state: "merged" })],
    }));
    const thread = threadOf(readModel);
    expect(
      (thread.pullRequests ?? []).map((link) => [link.pullRequest.number, link.source]),
    ).toEqual([[1, "agent"]]);
    expect(thread.lastKnownPr).toEqual(pr(1, { state: "merged" }));
  });

  it("unlinks with a tombstone that hides the PR", async () => {
    let readModel = await readModelWithThread();
    ({ readModel } = await dispatch(readModel, {
      type: "thread.pull-request.link",
      commandId: commandId(),
      threadId: THREAD_ID,
      pullRequest: pr(1),
      source: "agent",
    }));
    ({ readModel } = await dispatch(readModel, {
      type: "thread.pull-request.unlink",
      commandId: commandId(),
      threadId: THREAD_ID,
      url: "https://github.com/ACME/app/pull/1/files",
    }));
    const thread = threadOf(readModel);
    expect(thread.lastKnownPr).toBeNull();
    expect(thread.pullRequests?.[0]?.dismissedAt).toEqual(expect.any(String));
  });

  it("links a PR carried into a new thread as a checkout link", async () => {
    const thread = threadOf(await readModelWithThread(pr(3)));
    expect(thread.lastKnownPr).toEqual(pr(3));
    expect((thread.pullRequests ?? []).map((link) => link.source)).toEqual(["checkout"]);
  });

  it("maps legacy lastKnownPr meta updates onto links", async () => {
    let readModel = await readModelWithThread();
    ({ readModel } = await dispatch(readModel, {
      type: "thread.pull-request.sync",
      commandId: commandId(),
      threadId: THREAD_ID,
      discovered: pr(4),
    }));
    ({ readModel } = await dispatch(readModel, {
      type: "thread.meta.update",
      commandId: commandId(),
      threadId: THREAD_ID,
      lastKnownPr: pr(6),
    }));
    expect((threadOf(readModel).pullRequests ?? []).map((link) => link.source)).toEqual([
      "discovered",
      "user",
    ]);

    ({ readModel } = await dispatch(readModel, {
      type: "thread.meta.update",
      commandId: commandId(),
      threadId: THREAD_ID,
      lastKnownPr: null,
    }));
    const thread = threadOf(readModel);
    expect((thread.pullRequests ?? []).map((link) => link.pullRequest.number)).toEqual([6]);
    expect(thread.lastKnownPr).toEqual(pr(6));
  });

  it("replays events written before links as the old single PR slot", async () => {
    const readModel = await readModelWithThread();
    const legacy = await apply(readModel, [
      {
        eventId: EventId.makeUnsafe("evt-legacy-pr"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        type: "thread.meta-updated",
        occurredAt: "2026-11-13T10:05:00.000Z",
        commandId: commandId(),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          lastKnownPr: pr(8),
          updatedAt: "2026-11-13T10:05:00.000Z",
        },
      } as Omit<OrchestrationEvent, "sequence">,
    ]);
    expect(threadOf(legacy).pullRequests).toEqual([
      { pullRequest: pr(8), source: "legacy", linkedAt: "2026-11-13T10:05:00.000Z" },
    ]);
  });
});
