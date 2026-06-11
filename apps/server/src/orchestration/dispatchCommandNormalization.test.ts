// FILE: dispatchCommandNormalization.test.ts
// Purpose: Verifies client command normalization for managed chat workspace setup.

import {
  CommandId,
  type ClientOrchestrationCommand,
  ProjectId,
} from "@t3tools/contracts";
import type { FileSystem, Path } from "effect";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeDispatchCommandNormalizer } from "./dispatchCommandNormalization";

function projectCreateCommand(
  overrides: Partial<Extract<ClientOrchestrationCommand, { type: "project.create" }>> = {},
): Extract<ClientOrchestrationCommand, { type: "project.create" }> {
  return {
    type: "project.create",
    commandId: CommandId.makeUnsafe("cmd-project-create"),
    projectId: ProjectId.makeUnsafe("project-chat"),
    kind: "chat",
    title: "Chat",
    workspaceRoot: "/Users/tester/Documents/Synara/2026-06-11/chat",
    createWorkspaceRootIfMissing: true,
    createdAt: "2026-06-11T21:30:43.000Z",
    ...overrides,
  };
}

describe("makeDispatchCommandNormalizer", () => {
  it("prepares managed date/slug chat workspace roots", async () => {
    const preparedRoots: string[] = [];
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      prepareChatWorkspaceRoot: (workspaceRoot) =>
        Effect.sync(() => {
          preparedRoots.push(workspaceRoot);
        }),
    });

    await Effect.runPromise(normalizer({ command: projectCreateCommand() }));

    expect(preparedRoots).toEqual(["/Users/tester/Documents/Synara/2026-06-11/chat"]);
  });

  it("does not prepare ordinary projects or the chat workspace root itself", async () => {
    const preparedRoots: string[] = [];
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      prepareChatWorkspaceRoot: (workspaceRoot) =>
        Effect.sync(() => {
          preparedRoots.push(workspaceRoot);
        }),
    });

    await Effect.runPromise(
      normalizer({
        command: projectCreateCommand({
          kind: "project",
          workspaceRoot: "/Users/tester/Documents/Synara/2026-06-11/app",
        }),
      }),
    );
    await Effect.runPromise(
      normalizer({
        command: projectCreateCommand({
          workspaceRoot: "/Users/tester/Documents/Synara",
        }),
      }),
    );

    expect(preparedRoots).toEqual([]);
  });
});
