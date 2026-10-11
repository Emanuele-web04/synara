import { existsSync } from "node:fs";

import { CommandId, ThreadId } from "@synara/contracts";
import { Effect, Option } from "effect";

import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type {
  AgentGatewayOperationRecord,
  AgentGatewayOperationRepositoryShape,
} from "./Services/AgentGatewayOperationRepository.ts";
import { gatewayIsoNow } from "./creationUtils.ts";
import { parseRecoverableCreationPlan } from "./operationPlan.ts";
import { errorText } from "./toolInput.ts";

/**
 * Compensate durable gateway operations that were interrupted by a server
 * restart. Recovery is deliberately conservative: a worktree is touched only
 * when its post-creation ownership proof still matches the live Git state.
 */
export function recoverInterruptedAgentGatewayOperations(input: {
  readonly operationRepository: Pick<
    AgentGatewayOperationRepositoryShape,
    "markCompensating" | "recordCompensationFailure" | "fail"
  > & {
    readonly listNonTerminal: () => Effect.Effect<
      ReadonlyArray<Pick<AgentGatewayOperationRecord, "operationId" | "status" | "planJson">>,
      Error
    >;
  };
  readonly creationSource?: "synara_mcp" | "external_mcp";
  readonly retainOnMissingThreadProjection?: boolean;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly git: GitCoreShape;
}) {
  return Effect.gen(function* () {
    const interruptedOperations = yield* input.operationRepository.listNonTerminal().pipe(
      Effect.catch((error) =>
        Effect.logWarning("agent gateway recovery could not list interrupted operations", {
          error: errorText(error),
        }).pipe(Effect.as([])),
      ),
    );
    yield* Effect.forEach(
      interruptedOperations,
      (operation) =>
        Effect.gen(function* () {
          if (operation.status === "reserved") {
            yield* input.operationRepository.fail({
              operationId: operation.operationId,
              errorJson: JSON.stringify({
                code: "server_restarted_before_dispatch",
                message:
                  "Synara restarted before dispatch began. No git or orchestration resources were touched.",
              }),
              now: gatewayIsoNow(),
            });
            return;
          }
          yield* input.operationRepository.markCompensating({
            operationId: operation.operationId,
            now: gatewayIsoNow(),
          });
          const plan = parseRecoverableCreationPlan(operation.planJson, operation.operationId);
          const recoveryErrors: string[] = [];
          const projectionDeferredThreadIds = new Set<string>();
          yield* Effect.forEach(
            [...plan].reverse(),
            (entry) =>
              Effect.gen(function* () {
                const projected = yield* input.snapshotQuery.getThreadShellById(
                  ThreadId.makeUnsafe(entry.ids.threadId),
                );
                if (Option.isSome(projected)) {
                  if (
                    projected.value.creationSource !== (input.creationSource ?? "synara_mcp") ||
                    projected.value.gatewayOperationId !== operation.operationId
                  ) {
                    return yield* Effect.fail(
                      new Error(
                        `Refusing to delete thread ${entry.ids.threadId}: gateway ownership does not match operation ${operation.operationId}.`,
                      ),
                    );
                  }
                  yield* input.orchestrationEngine.dispatch({
                    type: "thread.delete",
                    commandId: CommandId.makeUnsafe(entry.ids.compensateCommandId),
                    threadId: ThreadId.makeUnsafe(entry.ids.threadId),
                  });
                } else if (input.retainOnMissingThreadProjection) {
                  projectionDeferredThreadIds.add(entry.ids.threadId);
                  return yield* Effect.fail(
                    new Error(
                      `Cleanup remains pending for thread ${entry.ids.threadId}: its durable creation may still be awaiting projection.`,
                    ),
                  );
                }
              }).pipe(
                Effect.catch((error) => Effect.sync(() => recoveryErrors.push(errorText(error)))),
              ),
            { discard: true },
          );
          yield* Effect.forEach(
            [...plan].reverse(),
            (entry) =>
              projectionDeferredThreadIds.has(entry.ids.threadId)
                ? Effect.void
                : entry.environment === "worktree" && entry.plannedWorktreePath
                  ? input.git
                      .withMutation(
                        entry.workspaceRoot,
                        Effect.gen(function* () {
                          const plannedWorktreePath = entry.plannedWorktreePath;
                          const newBranch = entry.newBranch;
                          if (plannedWorktreePath === null) return;
                          const branch = newBranch
                            ? (yield* input.git.listBranches({
                                cwd: entry.workspaceRoot,
                              })).branches.find(
                                (candidate) => !candidate.isRemote && candidate.name === newBranch,
                              )
                            : null;
                          if (!entry.worktreeOwnership) {
                            if (existsSync(plannedWorktreePath) || branch) {
                              return yield* Effect.fail(
                                new Error(
                                  `Cleanup remains pending for unverified worktree plan ${plannedWorktreePath}; automatic removal is unsafe without a durable ownership marker.`,
                                ),
                              );
                            }
                            return;
                          }
                          if (!existsSync(plannedWorktreePath)) {
                            if (branch) {
                              return yield* Effect.fail(
                                new Error(
                                  `Refusing to delete branch ${newBranch}: the owned worktree is missing, so current branch ownership cannot be verified.`,
                                ),
                              );
                            }
                            return;
                          }
                          if (newBranch !== null && branch?.worktreePath !== plannedWorktreePath) {
                            return yield* Effect.fail(
                              new Error(
                                `Refusing to clean worktree ${plannedWorktreePath}: git does not register the operation-owned branch at that path.`,
                              ),
                            );
                          }
                          const verification = yield* input.git.verifyWorktreeOwnership({
                            path: plannedWorktreePath,
                            proof: {
                              token: entry.worktreeOwnership.token,
                              gitDir: entry.worktreeOwnership.gitDir,
                              branch: entry.worktreeOwnership.branch,
                              head: entry.worktreeOwnership.head,
                              ...(entry.worktreeOwnership.stateHash
                                ? { stateHash: entry.worktreeOwnership.stateHash }
                                : {}),
                            },
                          });
                          if (!verification.verified) {
                            return yield* Effect.fail(
                              new Error(
                                `Refusing to clean worktree ${plannedWorktreePath}: ${verification.reason ?? "ownership verification failed"}.`,
                              ),
                            );
                          }
                          yield* input.git.removeWorktree({
                            cwd: entry.workspaceRoot,
                            path: plannedWorktreePath,
                            // A verified baseline may intentionally contain copied local
                            // changes, so Git requires force even though ownership is proven.
                            force: true,
                          });
                          if (newBranch !== null) {
                            yield* input.git.deleteBranchIfUnchanged({
                              cwd: entry.workspaceRoot,
                              branch: newBranch,
                              expectedHead: entry.worktreeOwnership.head,
                            });
                          }
                        }),
                      )
                      .pipe(
                        Effect.catch((error) =>
                          Effect.sync(() => recoveryErrors.push(errorText(error))),
                        ),
                      )
                  : Effect.void,
            { discard: true },
          );
          if (recoveryErrors.length > 0) {
            yield* input.operationRepository.recordCompensationFailure({
              operationId: operation.operationId,
              errorJson: JSON.stringify({
                code: "recovery_compensation_failed",
                message:
                  "Synara could not fully compensate the interrupted operation during startup recovery. The sanitized operation remains retryable and some resources may require manual cleanup; no replacements will be created.",
                errors: recoveryErrors,
              }),
              now: gatewayIsoNow(),
            });
            yield* Effect.logWarning("agent gateway recovery remains incomplete", {
              operationId: operation.operationId,
              errors: recoveryErrors,
            });
            return;
          }
          yield* input.operationRepository.fail({
            operationId: operation.operationId,
            errorJson: JSON.stringify({
              code: "server_restarted",
              message:
                "Synara restarted before the operation completed. Deterministic operation-owned resources were compensated; no replacements were created.",
              compensatedCount: plan.length,
            }),
            now: gatewayIsoNow(),
          });
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const detail = errorText(error);
              yield* input.operationRepository
                .recordCompensationFailure({
                  operationId: operation.operationId,
                  errorJson: JSON.stringify({
                    code: "startup_recovery_failed",
                    message:
                      "Synara could not recover the interrupted operation. The sanitized operation remains retryable and resources may require manual cleanup; no replacements will be created.",
                    error: detail,
                  }),
                  now: gatewayIsoNow(),
                })
                .pipe(
                  Effect.catch((persistenceError) =>
                    Effect.logWarning("agent gateway recovery status could not be persisted", {
                      operationId: operation.operationId,
                      error: errorText(persistenceError),
                    }),
                  ),
                );
              yield* Effect.logWarning("agent gateway recovery failed", {
                operationId: operation.operationId,
                error: detail,
              });
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  });
}
