// FILE: spaces.test.ts
// Purpose: Covers the durable Space lifecycle and project reassignment invariants.

import { CommandId, ProjectId, SpaceId, type OrchestrationCommand } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

async function dispatch(
  readModel: ReturnType<typeof createEmptyReadModel>,
  command: OrchestrationCommand,
) {
  const decided = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  const eventBases = Array.isArray(decided) ? decided : [decided];
  let next = readModel;
  for (const eventBase of eventBases) {
    next = await Effect.runPromise(
      projectEvent(next, { ...eventBase, sequence: next.snapshotSequence + 1 }),
    );
  }
  return { events: eventBases, readModel: next };
}

describe("Spaces", () => {
  it("orders custom spaces, assigns projects, and moves them to Void on deletion", async () => {
    const createdAt = "2026-07-15T10:00:00.000Z";
    const workSpaceId = SpaceId.makeUnsafe("space-work");
    const sideSpaceId = SpaceId.makeUnsafe("space-side");
    const projectId = ProjectId.makeUnsafe("project-spaces");
    let readModel = createEmptyReadModel(createdAt);

    ({ readModel } = await dispatch(readModel, {
      type: "space.create",
      commandId: CommandId.makeUnsafe("cmd-space-work"),
      spaceId: workSpaceId,
      name: "Work",
      icon: "bag",
      createdAt,
    }));
    ({ readModel } = await dispatch(readModel, {
      type: "space.create",
      commandId: CommandId.makeUnsafe("cmd-space-side"),
      spaceId: sideSpaceId,
      name: "Side projects",
      icon: "rocket",
      createdAt,
    }));

    expect(readModel.spaces.map((space) => [space.id, space.sortOrder])).toEqual([
      [workSpaceId, 0],
      [sideSpaceId, 1],
    ]);

    ({ readModel } = await dispatch(readModel, {
      type: "space.reorder",
      commandId: CommandId.makeUnsafe("cmd-space-reorder"),
      spaceId: sideSpaceId,
      orderedSpaceIds: [sideSpaceId, workSpaceId],
    }));
    expect(
      readModel.spaces
        .toSorted((left, right) => left.sortOrder - right.sortOrder)
        .map((space) => space.id),
    ).toEqual([sideSpaceId, workSpaceId]);

    ({ readModel } = await dispatch(readModel, {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-project-create"),
      projectId,
      title: "Synara",
      workspaceRoot: "/tmp/synara",
      createdAt,
    }));
    expect(readModel.projects[0]?.spaceId).toBeNull();

    ({ readModel } = await dispatch(readModel, {
      type: "project.meta.update",
      commandId: CommandId.makeUnsafe("cmd-project-assign"),
      projectId,
      spaceId: workSpaceId,
    }));
    expect(readModel.projects[0]?.spaceId).toBe(workSpaceId);

    const deletion = await dispatch(readModel, {
      type: "space.delete",
      commandId: CommandId.makeUnsafe("cmd-space-delete"),
      spaceId: workSpaceId,
    });
    readModel = deletion.readModel;
    expect(deletion.events.map((event) => event.type)).toEqual([
      "project.meta-updated",
      "space.deleted",
    ]);
    expect(readModel.projects[0]?.spaceId).toBeNull();
    expect(readModel.spaces.find((space) => space.id === workSpaceId)?.deletedAt).not.toBeNull();

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "space.create",
            commandId: CommandId.makeUnsafe("cmd-space-recreate-deleted-id"),
            spaceId: workSpaceId,
            name: "Recycled identity",
            icon: "star",
            createdAt,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow(/cannot be created twice/i);
  });

  it("reserves Void and enforces case-insensitive active-space names", async () => {
    const createdAt = "2026-07-15T10:00:00.000Z";
    const firstSpaceId = SpaceId.makeUnsafe("space-first");
    let readModel = createEmptyReadModel(createdAt);
    ({ readModel } = await dispatch(readModel, {
      type: "space.create",
      commandId: CommandId.makeUnsafe("cmd-space-first"),
      spaceId: firstSpaceId,
      name: "Work",
      icon: "home",
      createdAt,
    }));

    const duplicate = decideOrchestrationCommand({
      command: {
        type: "space.create",
        commandId: CommandId.makeUnsafe("cmd-space-duplicate"),
        spaceId: SpaceId.makeUnsafe("space-duplicate"),
        name: "work",
        icon: "star",
        createdAt,
      },
      readModel,
    });
    await expect(Effect.runPromise(duplicate)).rejects.toThrow(/already exists/i);

    const reserved = decideOrchestrationCommand({
      command: {
        type: "space.meta.update",
        commandId: CommandId.makeUnsafe("cmd-space-reserved"),
        spaceId: firstSpaceId,
        name: "Void",
      },
      readModel,
    });
    await expect(Effect.runPromise(reserved)).rejects.toThrow(/reserved/i);
  });

  it("rejects dangling assignments, non-project assignments, and partial reorder lists", async () => {
    const createdAt = "2026-07-15T10:00:00.000Z";
    const workSpaceId = SpaceId.makeUnsafe("space-work");
    const sideSpaceId = SpaceId.makeUnsafe("space-side");
    const projectId = ProjectId.makeUnsafe("project-work");
    const chatProjectId = ProjectId.makeUnsafe("project-chat");
    let readModel = createEmptyReadModel(createdAt);

    for (const [spaceId, name, icon] of [
      [workSpaceId, "Work", "bag"],
      [sideSpaceId, "Side", "rocket"],
    ] as const) {
      ({ readModel } = await dispatch(readModel, {
        type: "space.create",
        commandId: CommandId.makeUnsafe(`cmd-create-${spaceId}`),
        spaceId,
        name,
        icon,
        createdAt,
      }));
    }

    ({ readModel } = await dispatch(readModel, {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-create-project"),
      projectId,
      title: "Work project",
      workspaceRoot: "/tmp/work-project",
      createdAt,
    }));
    ({ readModel } = await dispatch(readModel, {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-create-chat"),
      projectId: chatProjectId,
      kind: "chat",
      title: "Chat",
      workspaceRoot: "/tmp/chat",
      createdAt,
    }));

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("cmd-assign-missing"),
            projectId,
            spaceId: SpaceId.makeUnsafe("space-missing"),
          },
          readModel,
        }),
      ),
    ).rejects.toThrow(/does not exist/i);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("cmd-assign-chat"),
            projectId: chatProjectId,
            spaceId: workSpaceId,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow(/ordinary projects/i);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "space.reorder",
            commandId: CommandId.makeUnsafe("cmd-partial-reorder"),
            spaceId: workSpaceId,
            orderedSpaceIds: [workSpaceId],
          },
          readModel,
        }),
      ),
    ).rejects.toThrow(/every active custom space/i);
  });

  it("drops unchanged metadata fields and rejects a save that changes nothing", async () => {
    const createdAt = "2026-07-15T10:00:00.000Z";
    const spaceId = SpaceId.makeUnsafe("space-meta");
    let readModel = createEmptyReadModel(createdAt);
    ({ readModel } = await dispatch(readModel, {
      type: "space.create",
      commandId: CommandId.makeUnsafe("cmd-space-meta"),
      spaceId,
      name: "Work",
      icon: "bag",
      createdAt,
    }));

    // The editor always resends both fields; identical values must not become an event.
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "space.meta.update",
            commandId: CommandId.makeUnsafe("cmd-space-noop"),
            spaceId,
            name: "Work",
            icon: "bag",
          },
          readModel,
        }),
      ),
    ).rejects.toThrow(/must change/i);

    const iconOnly = await dispatch(readModel, {
      type: "space.meta.update",
      commandId: CommandId.makeUnsafe("cmd-space-icon"),
      spaceId,
      name: "Work",
      icon: "star",
    });
    expect(iconOnly.events).toHaveLength(1);
    expect(iconOnly.events[0]?.payload).not.toHaveProperty("name");
    expect(iconOnly.events[0]?.payload).toHaveProperty("icon", "star");
  });

  it("rejects filing a legacy Home chat container into a space", async () => {
    const createdAt = "2026-07-15T10:00:00.000Z";
    const spaceId = SpaceId.makeUnsafe("space-work");
    const legacyHomeProjectId = ProjectId.makeUnsafe("project-legacy-home");
    const ordinaryProjectId = ProjectId.makeUnsafe("project-ordinary");
    const workspacePaths = {
      homeDir: "/Users/dev",
      chatWorkspaceRoot: "/Users/dev/Documents/Synara/Chats",
    };
    let readModel = createEmptyReadModel(createdAt);

    ({ readModel } = await dispatch(readModel, {
      type: "space.create",
      commandId: CommandId.makeUnsafe("cmd-space-work"),
      spaceId,
      name: "Work",
      icon: "bag",
      createdAt,
    }));
    // Legacy containers predate the "chat" kind: an ordinary-looking project row named
    // "Home" whose root is the home directory.
    ({ readModel } = await dispatch(readModel, {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-create-legacy-home"),
      projectId: legacyHomeProjectId,
      title: "Home",
      workspaceRoot: "/Users/dev",
      createdAt,
    }));
    ({ readModel } = await dispatch(readModel, {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-create-ordinary"),
      projectId: ordinaryProjectId,
      title: "Synara",
      workspaceRoot: "/Users/dev/code/synara",
      createdAt,
    }));

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("cmd-assign-legacy-home"),
            projectId: legacyHomeProjectId,
            spaceId,
          },
          readModel,
          workspacePaths,
        }),
      ),
    ).rejects.toThrow(/chats container/i);

    // Keep the legacy discriminator stable: ordinary projects may legitimately own these
    // roots, so the old Home row cannot be allowed to shed its canonical title.
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("cmd-rename-legacy-home"),
            projectId: legacyHomeProjectId,
            title: "Personal chats",
          },
          readModel,
          workspacePaths,
        }),
      ),
    ).rejects.toThrow(/cannot be renamed/i);

    // An ordinary project named anything else files normally under the same paths.
    const assigned = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-assign-ordinary"),
          projectId: ordinaryProjectId,
          spaceId,
        },
        readModel,
        workspacePaths,
      }),
    );
    const assignedEvents = Array.isArray(assigned) ? assigned : [assigned];
    expect(assignedEvents[0]?.type).toBe("project.meta-updated");
  });

  it("assigns a batch of projects atomically, skipping settled ones", async () => {
    const createdAt = "2026-07-15T10:00:00.000Z";
    const spaceId = SpaceId.makeUnsafe("space-work");
    const firstProjectId = ProjectId.makeUnsafe("project-first");
    const settledProjectId = ProjectId.makeUnsafe("project-settled");
    let readModel = createEmptyReadModel(createdAt);

    ({ readModel } = await dispatch(readModel, {
      type: "space.create",
      commandId: CommandId.makeUnsafe("cmd-space-work"),
      spaceId,
      name: "Work",
      icon: "bag",
      createdAt,
    }));
    for (const [projectId, title, workspaceRoot] of [
      [firstProjectId, "First", "/tmp/first"],
      [settledProjectId, "Settled", "/tmp/settled"],
    ] as const) {
      ({ readModel } = await dispatch(readModel, {
        type: "project.create",
        commandId: CommandId.makeUnsafe(`cmd-create-${projectId}`),
        projectId,
        title,
        workspaceRoot,
        createdAt,
      }));
    }
    ({ readModel } = await dispatch(readModel, {
      type: "project.meta.update",
      commandId: CommandId.makeUnsafe("cmd-settle-project"),
      projectId: settledProjectId,
      spaceId,
    }));

    // Already-assigned projects are settled and produce no event; the rest move.
    const batch = await dispatch(readModel, {
      type: "space.projects.assign",
      commandId: CommandId.makeUnsafe("cmd-batch-assign"),
      spaceId,
      projectIds: [firstProjectId, settledProjectId, firstProjectId],
    });
    expect(batch.events.map((event) => [event.type, event.aggregateId])).toEqual([
      ["project.meta-updated", firstProjectId],
    ]);
    expect(batch.readModel.projects.map((project) => [project.id, project.spaceId])).toEqual([
      [firstProjectId, spaceId],
      [settledProjectId, spaceId],
    ]);

    // A batch where nothing needs to move is rejected rather than emitting no events.
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "space.projects.assign",
            commandId: CommandId.makeUnsafe("cmd-batch-settled"),
            spaceId,
            projectIds: [settledProjectId],
          },
          readModel: batch.readModel,
        }),
      ),
    ).rejects.toThrow(/already in this space/i);
  });

  it("files new projects into the requested space, degrading unusable targets to Void", async () => {
    const createdAt = "2026-07-15T10:00:00.000Z";
    const spaceId = SpaceId.makeUnsafe("space-work");
    let readModel = createEmptyReadModel(createdAt);
    ({ readModel } = await dispatch(readModel, {
      type: "space.create",
      commandId: CommandId.makeUnsafe("cmd-space-work"),
      spaceId,
      name: "Work",
      icon: "bag",
      createdAt,
    }));

    ({ readModel } = await dispatch(readModel, {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-create-filed"),
      projectId: ProjectId.makeUnsafe("project-filed"),
      title: "Filed",
      workspaceRoot: "/tmp/filed",
      spaceId,
      createdAt,
    }));
    expect(readModel.projects.find((p) => p.id === "project-filed")?.spaceId).toBe(spaceId);

    // Creation never fails on an unusable target: a dangling space degrades to Void…
    ({ readModel } = await dispatch(readModel, {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-create-dangling"),
      projectId: ProjectId.makeUnsafe("project-dangling"),
      title: "Dangling",
      workspaceRoot: "/tmp/dangling",
      spaceId: SpaceId.makeUnsafe("space-missing"),
      createdAt,
    }));
    expect(readModel.projects.find((p) => p.id === "project-dangling")?.spaceId).toBeNull();

    // …and non-ordinary kinds ignore the field entirely.
    ({ readModel } = await dispatch(readModel, {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-create-chat-kind"),
      projectId: ProjectId.makeUnsafe("project-chat-kind"),
      kind: "chat",
      title: "Chat",
      workspaceRoot: "/tmp/chat-kind",
      spaceId,
      createdAt,
    }));
    expect(readModel.projects.find((p) => p.id === "project-chat-kind")?.spaceId).toBeNull();
  });

  it("re-files deleted projects out of a space when the space is deleted", async () => {
    const createdAt = "2026-07-15T10:00:00.000Z";
    const spaceId = SpaceId.makeUnsafe("space-work");
    const projectId = ProjectId.makeUnsafe("project-doomed");
    let readModel = createEmptyReadModel(createdAt);

    ({ readModel } = await dispatch(readModel, {
      type: "space.create",
      commandId: CommandId.makeUnsafe("cmd-space-work"),
      spaceId,
      name: "Work",
      icon: "bag",
      createdAt,
    }));
    ({ readModel } = await dispatch(readModel, {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-create-project"),
      projectId,
      title: "Doomed",
      workspaceRoot: "/tmp/doomed",
      createdAt,
    }));
    ({ readModel } = await dispatch(readModel, {
      type: "project.meta.update",
      commandId: CommandId.makeUnsafe("cmd-assign-project"),
      projectId,
      spaceId,
    }));
    ({ readModel } = await dispatch(readModel, {
      type: "project.delete",
      commandId: CommandId.makeUnsafe("cmd-delete-project"),
      projectId,
    }));
    expect(readModel.projects[0]?.deletedAt).not.toBeNull();
    expect(readModel.projects[0]?.spaceId).toBe(spaceId);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("cmd-reassign-deleted-project"),
            projectId,
            spaceId,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow(/deleted projects cannot be assigned/i);

    const deletion = await dispatch(readModel, {
      type: "space.delete",
      commandId: CommandId.makeUnsafe("cmd-delete-space"),
      spaceId,
    });
    expect(deletion.events.map((event) => event.type)).toEqual([
      "project.meta-updated",
      "space.deleted",
    ]);
    expect(deletion.readModel.projects[0]?.spaceId).toBeNull();
    expect(deletion.readModel.projects[0]?.deletedAt).not.toBeNull();
  });
});
