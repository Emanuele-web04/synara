import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OrchestrationProject } from "@synara/contracts";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { makeProjectWorktreeGuard } from "./wsRpc";

const project = (root: string, additionalFolders: string[]) =>
  Schema.decodeUnknownSync(OrchestrationProject)({
    id: "project-1",
    title: "Project",
    workspaceRoot: root,
    defaultModelSelection: null,
    scripts: [],
    additionalFolders,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    deletedAt: null,
  });

describe("project worktree admission", () => {
  it("refuses a canonical project's alias before Git can create an orphaned worktree", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "synara-project-worktree-"));
    try {
      const primary = path.join(fixture, "primary");
      const alias = path.join(fixture, "alias");
      await fs.mkdir(primary);
      await fs.symlink(primary, alias, "dir");
      const canonical = await fs.realpath(primary);
      const guard = makeProjectWorktreeGuard({
        canonicalizeWorkspaceRoot: (cwd) => Effect.tryPromise(() => fs.realpath(cwd)),
        getActiveProjectByWorkspaceRoot: (cwd) =>
          Effect.succeed(
            cwd === canonical ? Option.some(project(canonical, ["/extra"])) : Option.none(),
          ),
      });
      let mutated = false;
      const outcome = await Effect.runPromiseExit(
        guard(`${alias}${path.sep}`).pipe(
          Effect.andThen(
            Effect.sync(() => {
              mutated = true;
            }),
          ),
        ),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(JSON.stringify(outcome)).toContain("Use Local mode");
      expect(mutated).toBe(false);
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("does not treat a failed project lookup as permission to mutate Git", async () => {
    const guard = makeProjectWorktreeGuard({
      canonicalizeWorkspaceRoot: (cwd) => Effect.succeed(cwd),
      getActiveProjectByWorkspaceRoot: () => Effect.fail(new Error("project lookup unavailable")),
    });
    let mutated = false;
    const outcome = await Effect.runPromiseExit(
      guard("/project").pipe(
        Effect.andThen(
          Effect.sync(() => {
            mutated = true;
          }),
        ),
      ),
    );
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(Exit.isFailure(outcome) ? Cause.squash(outcome.cause) : undefined).toMatchObject({
      message: "project lookup unavailable",
    });
    expect(mutated).toBe(false);
  });

  it.each([Option.some(project("/project", [])), Option.none()])(
    "keeps ordinary or unlinked Git workspaces eligible",
    async (stored) => {
      const guard = makeProjectWorktreeGuard({
        canonicalizeWorkspaceRoot: (cwd) => Effect.succeed(cwd),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(stored),
      });
      let mutated = false;
      await Effect.runPromise(
        guard("/project").pipe(
          Effect.andThen(
            Effect.sync(() => {
              mutated = true;
            }),
          ),
        ),
      );
      expect(mutated).toBe(true);
    },
  );
});
