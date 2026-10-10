import { Effect, FileSystem, Layer, Path } from "effect";
import { describe, expect, it } from "vitest";

import { ensureStudioWorkspaceInstructionsFiles } from "./studioWorkspaceScaffold";

function makeFakeFileSystemLayer(existingPaths: ReadonlySet<string>) {
  const written: Array<{ path: string; content: string }> = [];
  const fileSystemLayer = FileSystem.layerNoop({
    exists: (path: string) => Effect.succeed(existingPaths.has(path)),
    writeFileString: (path: string, content: string) =>
      Effect.sync(() => {
        written.push({ path, content });
      }),
  });
  return { layer: Layer.merge(fileSystemLayer, Path.layer), written };
}

describe("ensureStudioWorkspaceInstructionsFiles", () => {
  it("writes AGENTS.md and CLAUDE.md with the same instructions when missing", async () => {
    const { layer, written } = makeFakeFileSystemLayer(new Set());

    await Effect.runPromise(
      ensureStudioWorkspaceInstructionsFiles("/studio").pipe(Effect.provide(layer)),
    );

    expect(written.map((file) => file.path)).toEqual(["/studio/AGENTS.md", "/studio/CLAUDE.md"]);
    expect(written[0]?.content).toContain("Outbox/<Category>/");
    expect(written[0]?.content).toBe(written[1]?.content);
  });

  it("never overwrites an instruction file the user already has", async () => {
    const { layer, written } = makeFakeFileSystemLayer(new Set(["/studio/AGENTS.md"]));

    await Effect.runPromise(
      ensureStudioWorkspaceInstructionsFiles("/studio").pipe(Effect.provide(layer)),
    );

    expect(written.map((file) => file.path)).toEqual(["/studio/CLAUDE.md"]);
  });
});
