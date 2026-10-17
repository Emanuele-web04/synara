// FILE: ProjectAgentRepository.documentTransactions.test.ts
// Purpose: Coverage for the multi-document transaction a memory-note edit uses —
//          a note and its generated index line must move together or not at all.
// Layer: Server persistence tests

import { ProjectDocumentRevisionId, ProjectId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { ProjectAgentRepository } from "../Services/ProjectAgentRepository.ts";
import { ProjectAgentRepositoryLive } from "./ProjectAgentRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectAgentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const now = "2026-10-01T12:00:00.000Z";
const notePath = "memory/2026-10-01-standup.md";
const indexPath = "memory/MEMORY.md";

// Each test owns its project, so revision ids stay unique on the shared layer.
let projectCounter = 0;
const makeFixture = () => {
  const projectId = ProjectId.makeUnsafe(`project-mem-notes-${(projectCounter += 1)}`);
  let counter = 0;
  const revision = (input: {
    readonly logicalPath: string;
    readonly content: string;
    readonly revision: number;
  }) => ({
    id: ProjectDocumentRevisionId.makeUnsafe(`${projectId}-rev-${(counter += 1)}`),
    projectId,
    logicalPath: input.logicalPath,
    revision: input.revision,
    content: input.content,
    contentHash: `hash-${input.logicalPath}-${input.revision}`,
    authorKind: "system" as const,
    authorThreadId: null,
    sources: [],
    createdAt: now,
  });
  return { projectId, revision };
};

layer("ProjectAgentRepository.applyDocumentChanges", (it) => {
  it.effect("commits a note and its index line together", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const { projectId, revision } = makeFixture();
      yield* repository.writeDocument({
        expectedRevision: null,
        revision: revision({ logicalPath: notePath, content: "ten", revision: 1 }),
      });
      yield* repository.writeDocument({
        expectedRevision: null,
        revision: revision({ logicalPath: indexPath, content: "- [Standup](a)", revision: 1 }),
      });

      yield* repository.applyDocumentChanges({
        projectId,
        upserts: [
          {
            expectedRevision: 1,
            revision: revision({
              logicalPath: notePath,
              content: "half past ten",
              revision: 2,
            }),
          },
          {
            expectedRevision: 1,
            revision: revision({ logicalPath: indexPath, content: "- [Standup](b)", revision: 2 }),
          },
        ],
        deletes: [],
      });

      const note = yield* repository.readDocumentRevision({ projectId, logicalPath: notePath });
      const index = yield* repository.readDocumentRevision({ projectId, logicalPath: indexPath });
      assert.equal(Option.isSome(note) && note.value.content === "half past ten", true);
      assert.equal(Option.isSome(index) && index.value.content === "- [Standup](b)", true);
    }),
  );

  it.effect("rolls the whole transaction back when one write loses its CAS", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const { projectId, revision } = makeFixture();
      yield* repository.writeDocument({
        expectedRevision: null,
        revision: revision({ logicalPath: notePath, content: "ten", revision: 1 }),
      });
      yield* repository.writeDocument({
        expectedRevision: null,
        revision: revision({ logicalPath: indexPath, content: "- [Standup](a)", revision: 1 }),
      });

      // The note's expectation is stale; the index write must not survive it.
      const conflict = yield* Effect.exit(
        repository.applyDocumentChanges({
          projectId,
          upserts: [
            {
              expectedRevision: 0,
              revision: revision({ logicalPath: notePath, content: "nine", revision: 2 }),
            },
            {
              expectedRevision: 1,
              revision: revision({
                logicalPath: indexPath,
                content: "- [Standup](b)",
                revision: 2,
              }),
            },
          ],
          deletes: [],
        }),
      );
      assert.equal(Exit.isFailure(conflict), true);

      const indexAfterConflict = yield* repository.readDocumentRevision({
        projectId,
        logicalPath: indexPath,
      });
      const noteAfterConflict = yield* repository.readDocumentRevision({
        projectId,
        logicalPath: notePath,
      });
      assert.equal(
        Option.isSome(indexAfterConflict) && indexAfterConflict.value.content === "- [Standup](a)",
        true,
      );
      assert.equal(
        Option.isSome(noteAfterConflict) && noteAfterConflict.value.content === "ten",
        true,
      );
    }),
  );

  it.effect("deletes a note and rewrites the index in the same transaction", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const { projectId, revision } = makeFixture();
      yield* repository.writeDocument({
        expectedRevision: null,
        revision: revision({ logicalPath: notePath, content: "ten", revision: 1 }),
      });
      yield* repository.writeDocument({
        expectedRevision: null,
        revision: revision({ logicalPath: indexPath, content: "- [Standup](a)", revision: 1 }),
      });

      yield* repository.applyDocumentChanges({
        projectId,
        upserts: [
          {
            expectedRevision: 1,
            revision: revision({ logicalPath: indexPath, content: "# Memory\n", revision: 2 }),
          },
        ],
        deletes: [{ logicalPath: notePath, expectedRevision: 1 }],
      });

      const deletedHead = yield* repository.getDocumentHead(projectId, notePath);
      assert.equal(Option.isNone(deletedHead), true);
      const index = yield* repository.readDocumentRevision({ projectId, logicalPath: indexPath });
      assert.equal(Option.isSome(index) && index.value.content === "# Memory\n", true);

      // A stale delete expectation leaves the row untouched.
      const staleDelete = yield* Effect.exit(
        repository.applyDocumentChanges({
          projectId,
          upserts: [],
          deletes: [{ logicalPath: indexPath, expectedRevision: 99 }],
        }),
      );
      assert.equal(Exit.isFailure(staleDelete), true);
      const indexStill = yield* repository.readDocumentRevision({
        projectId,
        logicalPath: indexPath,
      });
      assert.equal(Option.isSome(indexStill), true);
    }),
  );
});
