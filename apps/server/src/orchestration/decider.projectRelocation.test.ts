import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  OrchestrationCommand,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-09-18T10:00:00.000Z";
const decodeCommand = Schema.decodeUnknownSync(OrchestrationCommand);

async function apply(readModel: OrchestrationReadModel, input: unknown) {
  const result = await Effect.runPromise(
    decideOrchestrationCommand({ readModel, command: decodeCommand(input) }),
  );
  const events = Array.isArray(result) ? result : [result];
  let next = readModel;
  for (const event of events) {
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 }),
    );
  }
  return next;
}

async function fixture(workingDirectory: string | null = null) {
  let model = await apply(createEmptyReadModel(now), {
    type: "project.create",
    commandId: "create-project",
    projectId: "project-1",
    title: "Restored project",
    workspaceRoot: "/old/repo",
    createdAt: now,
  });
  model = await apply(model, {
    type: "thread.create",
    commandId: "create-thread",
    threadId: "thread-1",
    projectId: "project-1",
    title: "Earlier conversation",
    modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    envMode: "local",
    branch: null,
    worktreePath: null,
    workingDirectory,
    createdAt: now,
  });
  return apply(model, {
    type: "thread.messages.import",
    commandId: "import-context",
    threadId: "thread-1",
    createdAt: now,
    messages: [
      {
        messageId: "message-1",
        role: "user",
        text: "Earlier context mentions /old/repo.",
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
}

const relocation = {
  type: "project.meta.update",
  commandId: CommandId.makeUnsafe("relocate"),
  projectId: "project-1",
  workspaceRoot: "/restored/repo",
};

describe("project relocation", () => {
  it("keeps project, thread, and message identities and history without reading the missing old disk", async () => {
    const before = await fixture();
    const after = await apply(before, relocation);
    expect(after.projects).toHaveLength(1);
    expect(after.projects[0]).toMatchObject({
      id: before.projects[0]!.id,
      workspaceRoot: "/restored/repo",
      title: "Restored project",
    });
    expect(after.threads).toEqual(before.threads);
    expect(before.projects[0]!.workspaceRoot).toBe("/old/repo");
  });

  it("relocates explicit subdirectories in the same command batch, including archived threads", async () => {
    let before = await fixture("/old/repo/packages/app");
    before = await apply(before, {
      type: "thread.archive",
      commandId: "archive",
      threadId: "thread-1",
      createdAt: now,
    });
    const archivedAt = before.threads[0]!.archivedAt;
    expect(archivedAt).not.toBeNull();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({ readModel: before, command: decodeCommand(relocation) }),
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result).toMatchObject([
      {
        type: "project.meta-updated",
        payload: { projectId: "project-1", workspaceRoot: "/restored/repo" },
      },
      {
        type: "thread.meta-updated",
        payload: { threadId: "thread-1", workingDirectory: "/restored/repo/packages/app" },
      },
    ]);
    const after = await apply(before, relocation);
    expect(after.threads[0]).toMatchObject({
      id: "thread-1",
      projectId: "project-1",
      workingDirectory: "/restored/repo/packages/app",
      archivedAt,
    });
    expect(after.threads[0]!.messages).toEqual(before.threads[0]!.messages);
  });

  it("leaves explicit paths outside the old root alone", async () => {
    const before = await fixture("/old/repository");
    const after = await apply(before, relocation);
    expect(after.threads[0]!.workingDirectory).toBe("/old/repository");
  });

  it("rejects a live turn instead of rebinding a running process", async () => {
    let before = await fixture();
    before = await apply(before, {
      type: "thread.session.set",
      commandId: "running",
      threadId: "thread-1",
      createdAt: now,
      session: {
        threadId: "thread-1",
        status: "running",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: "turn-1",
        lastError: null,
        updatedAt: now,
      },
    });
    await expect(apply(before, relocation)).rejects.toThrow("Stop active turns");
    expect(before.projects[0]!.workspaceRoot).toBe("/old/repo");
  });

  it("allows terminal provider errors with stale active-turn attribution", async () => {
    let before = await fixture();
    before = await apply(before, {
      type: "thread.session.set",
      commandId: "failed",
      threadId: "thread-1",
      createdAt: now,
      session: {
        threadId: "thread-1",
        status: "error",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: "failed-turn",
        lastError: "missing cwd",
        updatedAt: now,
      },
    });
    const after = await apply(before, relocation);
    expect(after.threads[0]!.session).toEqual(before.threads[0]!.session);
  });

  it("refuses linked worktrees inside the moved root instead of rewriting broken Git links", async () => {
    let before = await fixture();
    before = await apply(before, {
      type: "thread.meta.update",
      commandId: "worktree",
      threadId: "thread-1",
      envMode: "worktree",
      branch: "feature",
      worktreePath: "/old/repo/worktrees/feature",
    });
    await expect(apply(before, relocation)).rejects.toThrow("linked Git worktrees");
    expect(before.projects[0]!.workspaceRoot).toBe("/old/repo");
  });

  it("retains the existing duplicate-project-root invariant", async () => {
    const before = await apply(await fixture(), {
      type: "project.create",
      commandId: "other",
      projectId: "project-2",
      title: "Other",
      workspaceRoot: "/restored/repo",
      createdAt: now,
    });
    await expect(apply(before, relocation)).rejects.toThrow();
  });
});
