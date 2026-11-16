import { CommandId, ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  GIT_HANDOFF_PHASE_TRANSITIONS,
  beginGitHandoff,
  canTransitionGitHandoff,
  completeGitHandoff,
  discardPendingGitHandoff,
  recordGitHandoffResult,
  recoverGitHandoffOperations,
  type GitHandoffPhase,
} from "./gitHandoffOperations.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

const layer = it.layer(SqlitePersistenceMemory);

const input = {
  commandId: CommandId.makeUnsafe("git-handoff-recovery-command"),
  threadId: ThreadId.makeUnsafe("git-handoff-recovery-thread"),
  cwd: "/repo",
  targetMode: "worktree" as const,
  currentBranch: "main",
  worktreePath: null,
  associatedWorktreePath: null,
  associatedWorktreeBranch: null,
  associatedWorktreeRef: null,
  preferredLocalBranch: null,
  preferredWorktreeBaseBranch: "main",
  preferredNewWorktreeName: "feature/recovery",
};

const result = {
  targetMode: "worktree" as const,
  branch: "feature/recovery",
  worktreePath: "/worktrees/recovery",
  associatedWorktreePath: "/worktrees/recovery",
  associatedWorktreeBranch: "feature/recovery",
  associatedWorktreeRef: "abc123",
  changesTransferred: true,
  conflictsDetected: false,
  message: "Recovered",
};

layer("Git handoff operation recovery", (it) => {
  it.effect(
    "replays durable Git results without running Git again and fences incomplete work",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM git_handoff_operations`;

        assert.deepStrictEqual(yield* beginGitHandoff(input), { phase: "new" });
        yield* recordGitHandoffResult(input.commandId, result);
        assert.deepStrictEqual(yield* beginGitHandoff(input), {
          phase: "git_applied",
          result,
        });

        const dispatched: unknown[] = [];
        yield* recoverGitHandoffOperations((command) =>
          Effect.sync(() => {
            dispatched.push(command);
          }),
        );
        assert.lengthOf(dispatched, 1);
        assert.deepInclude(dispatched[0] as object, {
          type: "thread.meta.update",
          commandId: input.commandId,
          threadId: input.threadId,
          worktreePath: result.worktreePath,
        });
        assert.deepStrictEqual(yield* beginGitHandoff(input), { phase: "completed", result });

        const interruptedInput = {
          ...input,
          commandId: CommandId.makeUnsafe("git-handoff-interrupted-command"),
        };
        assert.deepStrictEqual(yield* beginGitHandoff(interruptedInput), { phase: "new" });
        yield* recoverGitHandoffOperations(() => Effect.void);
        assert.deepStrictEqual(yield* beginGitHandoff(interruptedInput), { phase: "uncertain" });
      }),
  );

  // The SQL guards are the authoritative enforcement of the handoff state machine. Drive
  // every helper from every phase so a guard that drifts from the declared table fails here
  // instead of rerunning Git or replaying a stale result.
  it.effect("moves a handoff only along the declared lifecycle transitions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const commandId = CommandId.makeUnsafe("git-handoff-lifecycle-command");
      const lifecycleInput = { ...input, commandId };
      // Each helper maps the phases it acts on to the resulting phase (null: row deleted).
      const helpers = {
        recordGitHandoffResult: {
          effects: { pending: "git_applied" },
          run: recordGitHandoffResult(commandId, result),
        },
        completeGitHandoff: {
          effects: { git_applied: "completed" },
          run: completeGitHandoff(commandId),
        },
        recoverGitHandoffOperations: {
          effects: { pending: "uncertain", git_applied: "completed" },
          run: recoverGitHandoffOperations(() => Effect.void),
        },
        discardPendingGitHandoff: {
          effects: { pending: null },
          run: discardPendingGitHandoff(commandId),
        },
      } satisfies Record<
        string,
        {
          readonly effects: Partial<Record<GitHandoffPhase, GitHandoffPhase | null>>;
          readonly run: Effect.Effect<unknown, unknown, SqlClient.SqlClient>;
        }
      >;

      const phases = Object.keys(GIT_HANDOFF_PHASE_TRANSITIONS) as GitHandoffPhase[];
      for (const [name, helper] of Object.entries(helpers)) {
        for (const from of phases) {
          yield* sql`DELETE FROM git_handoff_operations`;
          assert.deepStrictEqual(yield* beginGitHandoff(lifecycleInput), { phase: "new" });
          const hasResult = from === "git_applied" || from === "completed";
          yield* sql`
            UPDATE git_handoff_operations
            SET phase = ${from}, result_json = ${hasResult ? JSON.stringify(result) : null}
            WHERE command_id = ${commandId}
          `;

          yield* helper.run;

          const rows = yield* sql<{ readonly phase: GitHandoffPhase }>`
            SELECT phase FROM git_handoff_operations WHERE command_id = ${commandId}
          `;
          const effects: Partial<Record<GitHandoffPhase, GitHandoffPhase | null>> = helper.effects;
          const expected = from in effects ? (effects[from] ?? null) : from;
          assert.strictEqual(rows[0]?.phase ?? null, expected, `${name}: ${from}`);
          if (expected !== null && expected !== from) {
            assert.isTrue(canTransitionGitHandoff(from, expected), `${name}: ${from}`);
          }
        }
      }
    }),
  );
});
