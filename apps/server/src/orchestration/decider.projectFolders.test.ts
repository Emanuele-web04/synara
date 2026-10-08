import { OrchestrationCommand, type OrchestrationReadModel } from "@synara/contracts";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-10-06T10:00:00.000Z";
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

async function rejection(readModel: OrchestrationReadModel, input: unknown) {
  const exit = await Effect.runPromiseExit(
    decideOrchestrationCommand({ readModel, command: decodeCommand(input) }),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  return JSON.stringify(exit);
}

const createMultiFolder = (overrides: Record<string, unknown> = {}) => ({
  type: "project.create",
  commandId: "create-project",
  projectId: "project-1",
  title: "Product",
  workspaceRoot: "/repos/web",
  additionalFolders: ["/repos/api", "/repos/shared"],
  createdAt: now,
  ...overrides,
});

describe("multi-folder projects", () => {
  it("keeps workspaceRoot as the primary folder and stores the extra folders in order", async () => {
    const model = await apply(createEmptyReadModel(now), createMultiFolder());
    const project = model.projects.find((entry) => entry.id === "project-1");
    expect(project?.workspaceRoot).toBe("/repos/web");
    expect(project?.additionalFolders).toEqual(["/repos/api", "/repos/shared"]);
  });

  it("leaves an ordinary project single-folder", async () => {
    const model = await apply(
      createEmptyReadModel(now),
      createMultiFolder({ additionalFolders: undefined }),
    );
    expect(model.projects[0]?.additionalFolders).toEqual([]);
  });

  it("rejects duplicate and nested folders", async () => {
    const empty = createEmptyReadModel(now);
    expect(
      await rejection(empty, createMultiFolder({ additionalFolders: ["/repos/web/"] })),
    ).toContain("web is already in this project.");
    expect(
      await rejection(empty, createMultiFolder({ additionalFolders: ["/repos/web/packages"] })),
    ).toContain("packages is inside web. Add only one of them.");
  });

  it("rejects extra folders on container projects", async () => {
    expect(
      await rejection(createEmptyReadModel(now), createMultiFolder({ kind: "chat" })),
    ).toContain("Only ordinary projects can have additional folders.");
  });

  it("refuses to relocate the primary folder into one of the extra folders", async () => {
    const model = await apply(createEmptyReadModel(now), createMultiFolder());
    expect(
      await rejection(model, {
        type: "project.meta.update",
        commandId: "relocate",
        projectId: "project-1",
        workspaceRoot: "/repos/api/src",
      }),
    ).toContain("src is inside api. Add only one of them.");
  });
});
