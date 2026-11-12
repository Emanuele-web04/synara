import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-07-19T00:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-move");
const SOURCE_PROJECT_ID = ProjectId.makeUnsafe("project-source");
const TARGET_PROJECT_ID = ProjectId.makeUnsafe("project-target");

type ReadModelProject = OrchestrationReadModel["projects"][number];

function makeProject(overrides: Partial<ReadModelProject> = {}): ReadModelProject {
  return {
    id: TARGET_PROJECT_ID,
    kind: "project",
    title: "Target",
    workspaceRoot: "/tmp/target",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeReadModel(input: {
  readonly sourceProject?: ReadModelProject;
  readonly targetProject?: ReadModelProject | null;
  readonly latestTurn?: OrchestrationLatestTurn | null;
  readonly session?: OrchestrationSession | null;
}): OrchestrationReadModel {
  const projects: ReadModelProject[] = [];
  if (input.sourceProject !== null) {
    projects.push(
      input.sourceProject ??
        makeProject({ id: SOURCE_PROJECT_ID, title: "Source", workspaceRoot: "/tmp/source" }),
    );
  }
  if (input.targetProject !== null && input.targetProject !== undefined) {
    projects.push(input.targetProject);
  } else if (input.targetProject === undefined) {
    projects.push(makeProject());
  }
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects,
    threads: [
      {
        id: THREAD_ID,
        projectId: SOURCE_PROJECT_ID,
        title: "Move me",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: input.latestTurn ?? null,
        handoff: null,
        messages: [],
        session: input.session ?? null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

function moveCommand(targetProjectId: ProjectId = TARGET_PROJECT_ID): OrchestrationCommand {
  return {
    type: "thread.meta.update",
    commandId: CommandId.makeUnsafe("cmd-move"),
    threadId: THREAD_ID,
    projectId: targetProjectId,
  };
}

const decide = (readModel: OrchestrationReadModel, command = moveCommand()) =>
  decideOrchestrationCommand({ command, readModel });

const expectRejected = async (readModel: OrchestrationReadModel, detail: string) => {
  const error = await Effect.runPromise(Effect.flip(decide(readModel)));
  expect(error).toMatchObject({
    _tag: "OrchestrationCommandInvariantError",
    commandType: "thread.meta.update",
    detail,
  });
};

const metaUpdatedEvents = async (readModel: OrchestrationReadModel, command = moveCommand()) => {
  const decided = await Effect.runPromise(decide(readModel, command));
  const events = Array.isArray(decided) ? decided : [decided];
  return events.filter((event) => event.type === "thread.meta-updated");
};

describe("decider thread.meta.update projectId", () => {
  it("moves the thread to another ordinary project", async () => {
    const events = await metaUpdatedEvents(makeReadModel({}));
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      threadId: THREAD_ID,
      projectId: TARGET_PROJECT_ID,
    });
  });

  it("rejects a move to a project that does not exist", async () => {
    await expectRejected(
      makeReadModel({ targetProject: null }),
      `Project '${TARGET_PROJECT_ID}' does not exist for command 'thread.meta.update'.`,
    );
  });

  it.each(["group", "studio", "chat"] as const)(
    "rejects a move into a %s container project",
    async (kind) => {
      await expectRejected(
        makeReadModel({ targetProject: makeProject({ kind }) }),
        `Project '${TARGET_PROJECT_ID}' cannot hold moved threads.`,
      );
    },
  );

  it("rejects moving a thread out of a container project", async () => {
    await expectRejected(
      makeReadModel({
        sourceProject: makeProject({
          id: SOURCE_PROJECT_ID,
          kind: "group",
          title: "Hub",
          workspaceRoot: "/tmp/hub",
        }),
      }),
      "Threads cannot be moved out of this project.",
    );
  });

  it("rejects a move while a turn is in flight", async () => {
    const runningTurn: OrchestrationLatestTurn = {
      turnId: TurnId.makeUnsafe("turn-running"),
      state: "running",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      assistantMessageId: null,
    };
    await expectRejected(
      makeReadModel({ latestTurn: runningTurn }),
      "Wait for the active turn or checkpoint restore to finish before moving the thread to another project.",
    );
  });

  it("treats a move to the current project as a no-op", async () => {
    const events = await metaUpdatedEvents(makeReadModel({}), moveCommand(SOURCE_PROJECT_ID));
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ threadId: THREAD_ID });
    expect(events[0]?.payload.projectId).toBeUndefined();
  });
});
