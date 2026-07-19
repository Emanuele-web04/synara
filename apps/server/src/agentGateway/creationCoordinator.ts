import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type ProviderKind,
  type SynaraCreateThreadsInput,
  type SynaraCreateThreadsResult,
} from "@synara/contracts";
import { buildPromptThreadTitleFallback } from "@synara/shared/chatThreads";
import { Effect, Option, Semaphore } from "effect";

import type { ServerConfigShape } from "../config.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import type { AgentGatewayOperationRepositoryShape } from "./Services/AgentGatewayOperationRepository.ts";
import {
  canonicalJson,
  gatewayIsoNow,
  makeAgentCreationIds,
  slugifyAgentTask,
  stableGatewayDigest,
} from "./creationUtils.ts";
import { mcpToolResultError, mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import {
  AgentGatewayTargetError,
  resolveAgentGatewayTarget,
  type AgentGatewayProviderAvailability,
} from "./targetResolver.ts";
import { ToolInputError, errorText } from "./toolInput.ts";
import { GatewayToolError, gatewayToolErrorResult, type ToolContext } from "./toolRuntime.ts";

const CREATION_REPLAY_WAIT_MS = 60_000;

interface CreationCoordinatorDependencies {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly git: GitCoreShape;
  readonly providerDiscovery: ProviderDiscoveryServiceShape;
  readonly operationRepository: AgentGatewayOperationRepositoryShape;
  readonly serverConfig: ServerConfigShape;
  readonly loadProviderAvailabilities: Effect.Effect<
    ReadonlyMap<ProviderKind, AgentGatewayProviderAvailability>,
    unknown
  >;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, ToolInputError>;
}

/**
 * Build the durable, exactly-once thread-creation coordinator.
 *
 * The coordinator owns its per-caller-turn locks and all git/orchestration
 * compensation state. Keeping that state beside the saga prevents the MCP
 * transport and unrelated tools from becoming accidental recovery owners.
 */
export const makeCreateThreadsHandler = Effect.fn(function* (
  dependencies: CreationCoordinatorDependencies,
) {
  const {
    snapshotQuery,
    orchestrationEngine,
    git,
    providerDiscovery,
    operationRepository,
    serverConfig,
    loadProviderAvailabilities,
    requireThreadShell,
  } = dependencies;
  const lockIndex = yield* Semaphore.make(1);
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();

  const withCreationPlanLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      lockIndex.withPermits(1)(
        Effect.gen(function* () {
          const existing = locks.get(key);
          if (existing) {
            existing.users += 1;
            return existing;
          }
          const entry = { lock: yield* Semaphore.make(1), users: 1 };
          locks.set(key, entry);
          return entry;
        }),
      ),
      (entry) => entry.lock.withPermits(1)(effect),
      (entry) =>
        lockIndex.withPermits(1)(
          Effect.sync(() => {
            entry.users -= 1;
            if (entry.users === 0 && locks.get(key) === entry) locks.delete(key);
          }),
        ),
    );

  const awaitCreationReplay = (
    operationId: string,
  ): Effect.Effect<McpToolCallResult, GatewayToolError | ToolInputError> =>
    Effect.gen(function* () {
      const deadline = Date.now() + CREATION_REPLAY_WAIT_MS;
      let operation = yield* operationRepository
        .getById(operationId)
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      while (
        operation !== null &&
        operation.status !== "completed" &&
        operation.status !== "failed" &&
        Date.now() < deadline
      ) {
        yield* Effect.sleep(25);
        operation = yield* operationRepository
          .getById(operationId)
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      }
      if (operation?.status === "completed") {
        return mcpToolResultJson(JSON.parse(operation.resultJson ?? "{}"));
      }
      if (operation?.status === "failed") {
        return yield* Effect.fail(
          new GatewayToolError(
            "operation_failed",
            "The original thread-creation operation failed; it will not create replacement threads.",
            {
              operationId,
              error: operation.errorJson ? JSON.parse(operation.errorJson) : null,
            },
          ),
        );
      }
      return yield* Effect.fail(
        new GatewayToolError(
          "operation_failed",
          "The original thread-creation operation is still in progress. Retry only with the same request id; Synara will not create replacement threads.",
          { operationId, status: operation?.status ?? "missing" },
        ),
      );
    });

  const appendThreadCreationRecap = (input: {
    readonly callerThreadId: string;
    readonly callerTurnId: string;
    readonly result: SynaraCreateThreadsResult;
  }) => {
    const marker = stableGatewayDigest({
      operationId: input.result.operationId,
      kind: "threads-created-recap",
    });
    const createdAt = gatewayIsoNow();
    const threadLabel = input.result.createdCount === 1 ? "thread" : "threads";
    return orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`agent:${marker}:threads-created-recap`),
        threadId: ThreadId.makeUnsafe(input.callerThreadId),
        activity: {
          id: EventId.makeUnsafe(`gateway:${marker}:threads-created-recap`),
          tone: "info",
          kind: "synara.threads.created",
          summary: `Created ${input.result.createdCount} Synara ${threadLabel}`,
          payload: {
            source: "synara_mcp",
            operationId: input.result.operationId,
            requestId: input.result.requestId,
            requestedCount: input.result.requestedCount,
            createdCount: input.result.createdCount,
            threads: JSON.parse(JSON.stringify(input.result.threads)),
          },
          turnId: TurnId.makeUnsafe(input.callerTurnId),
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("agent gateway could not append thread creation recap", {
            operationId: input.result.operationId,
            callerThreadId: input.callerThreadId,
            error: errorText(error),
          }),
        ),
      );
  };

  const run = (input: typeof SynaraCreateThreadsInput.Type, context: ToolContext) => {
    return Effect.gen(function* () {
      if (context.callerTurnId === null) {
        return yield* Effect.fail(
          new GatewayToolError(
            "caller_turn_inactive",
            "Thread creation requires an active caller turn.",
          ),
        );
      }
      const callerTurnId = context.callerTurnId;
      const caller = yield* requireThreadShell(context.callerThreadId);
      const operationId = `gateway:create:${stableGatewayDigest({
        callerThreadId: context.callerThreadId,
        callerTurnId,
        requestId: input.requestId,
      })}`;
      const fingerprint = stableGatewayDigest(input, 64);
      const existingOperation = yield* operationRepository
        .getByScope({
          callerThreadId: context.callerThreadId,
          callerTurnId,
          operationKind: "create_threads",
        })
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      if (existingOperation !== null) {
        if (existingOperation.requestId !== input.requestId) {
          return yield* Effect.fail(
            new GatewayToolError(
              "creation_plan_locked",
              "This caller turn already committed a different thread-creation plan. A new user turn is required for another plan.",
              {
                operationId: existingOperation.operationId,
                requestId: existingOperation.requestId,
                requestedCount: existingOperation.requestedCount,
                status: existingOperation.status,
              },
            ),
          );
        }
        if (existingOperation.fingerprint !== fingerprint) {
          return yield* Effect.fail(
            new GatewayToolError(
              "idempotency_conflict",
              `Request id "${input.requestId}" was already used with a different creation plan.`,
              { operationId: existingOperation.operationId },
            ),
          );
        }
        if (existingOperation.status === "completed") {
          return mcpToolResultJson(JSON.parse(existingOperation.resultJson ?? "{}"));
        }
        if (existingOperation.status === "failed") {
          return yield* Effect.fail(
            new GatewayToolError(
              "operation_failed",
              "The original thread-creation operation failed; it will not create replacement threads.",
              {
                operationId: existingOperation.operationId,
                error: existingOperation.errorJson ? JSON.parse(existingOperation.errorJson) : null,
              },
            ),
          );
        }
        return yield* awaitCreationReplay(existingOperation.operationId);
      }
      const callerIsolatedInWorktree = caller.envMode === "worktree";
      const providerAvailabilities = yield* loadProviderAvailabilities;

      const prepared = yield* Effect.forEach(input.threads, (spec, index) =>
        Effect.gen(function* () {
          const projectId = ProjectId.makeUnsafe(spec.projectId ?? caller.projectId);
          const project = yield* snapshotQuery.getProjectShellById(projectId).pipe(
            Effect.mapError((error) => new ToolInputError(errorText(error))),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new ToolInputError(`Project "${projectId}" was not found.`)),
                onSome: Effect.succeed,
              }),
            ),
          );
          const target = yield* resolveAgentGatewayTarget({
            target: spec.target,
            discovery: providerDiscovery,
            ...(providerAvailabilities.get(spec.target.provider) !== undefined
              ? { availability: providerAvailabilities.get(spec.target.provider)! }
              : {}),
            cwd: project.workspaceRoot,
          });
          const environment = spec.environment ?? (callerIsolatedInWorktree ? "worktree" : "local");
          if (environment === "local" && callerIsolatedInWorktree) {
            return yield* Effect.fail(
              new ToolInputError(
                'Your thread runs in an isolated worktree, so created threads cannot use environment "local".',
              ),
            );
          }
          if (spec.runtimeMode === "full-access" && caller.runtimeMode !== "full-access") {
            return yield* Effect.fail(
              new ToolInputError(
                'Your thread runs in "approval-required" mode, so created threads cannot use "full-access".',
              ),
            );
          }
          const runtimeMode = spec.runtimeMode ?? caller.runtimeMode;
          const title = spec.title ?? buildPromptThreadTitleFallback(spec.prompt);
          let baseBranch: string | null = null;
          let newBranch: string | null = null;
          let plannedWorktreePath: string | null = null;
          if (environment === "worktree") {
            const callerBranch =
              callerIsolatedInWorktree && caller.projectId === projectId
                ? (caller.branch ?? null)
                : null;
            baseBranch =
              spec.baseBranch ??
              callerBranch ??
              (yield* git.statusDetails(project.workspaceRoot).pipe(
                Effect.mapError((error) => new ToolInputError(errorText(error))),
                Effect.flatMap((status) =>
                  status.isRepo && status.branch
                    ? Effect.succeed(status.branch)
                    : Effect.fail(
                        new ToolInputError(
                          'The project is not on a git branch; pass baseBranch or use environment "local".',
                        ),
                      ),
                ),
              ));
            newBranch =
              spec.branchName ??
              `agent/${slugifyAgentTask(title)}-${stableGatewayDigest({ operationId, index }, 8)}`;
            plannedWorktreePath = join(
              serverConfig.worktreesDir,
              basename(project.workspaceRoot),
              newBranch.replace(/\//g, "-"),
            );
            if (existsSync(plannedWorktreePath)) {
              return yield* Effect.fail(
                new ToolInputError(
                  `Worktree path "${plannedWorktreePath}" already exists. Synara will not reuse or remove a pre-existing path.`,
                ),
              );
            }
            const branches = yield* git
              .listBranches({ cwd: project.workspaceRoot })
              .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
            if (branches.branches.some((branch) => !branch.isRemote && branch.name === newBranch)) {
              return yield* Effect.fail(
                new ToolInputError(
                  `Branch "${newBranch}" already exists. Synara will not reuse or remove a pre-existing branch.`,
                ),
              );
            }
          }
          return {
            index,
            spec,
            projectId,
            workspaceRoot: project.workspaceRoot,
            target,
            environment,
            runtimeMode,
            title,
            baseBranch,
            newBranch,
            plannedWorktreePath,
            ownershipPreflightPassed: true,
            ids: makeAgentCreationIds(operationId, index),
          };
        }),
      );

      const plannedWorktrees = prepared
        .map((entry) => entry.plannedWorktreePath)
        .filter((path): path is string => path !== null);
      if (new Set(plannedWorktrees).size !== plannedWorktrees.length) {
        return yield* Effect.fail(
          new ToolInputError(
            "The creation plan resolves multiple entries to the same worktree path. Use distinct branchName values.",
          ),
        );
      }

      const reservation = yield* operationRepository
        .reserve({
          operationId,
          callerThreadId: context.callerThreadId,
          callerTurnId,
          operationKind: "create_threads",
          requestId: input.requestId,
          fingerprint,
          requestedCount: prepared.length,
          planJson: canonicalJson(
            prepared.map((entry) => ({
              index: entry.index,
              spec: entry.spec,
              projectId: entry.projectId,
              workspaceRoot: entry.workspaceRoot,
              environment: entry.environment,
              runtimeMode: entry.runtimeMode,
              baseBranch: entry.baseBranch,
              newBranch: entry.newBranch,
              plannedWorktreePath: entry.plannedWorktreePath,
              ownershipPreflightPassed: entry.ownershipPreflightPassed,
              ids: entry.ids,
            })),
          ),
          now: gatewayIsoNow(),
        })
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));

      if (reservation.kind === "idempotency_conflict") {
        return yield* Effect.fail(
          new GatewayToolError(
            "idempotency_conflict",
            `Request id "${input.requestId}" was already used with a different creation plan.`,
            { operationId: reservation.operation.operationId },
          ),
        );
      }
      if (reservation.kind === "creation_plan_locked") {
        return yield* Effect.fail(
          new GatewayToolError(
            "creation_plan_locked",
            "This caller turn already committed a different thread-creation plan. A new user turn is required for another plan.",
            {
              operationId: reservation.operation.operationId,
              requestId: reservation.operation.requestId,
              requestedCount: reservation.operation.requestedCount,
              status: reservation.operation.status,
            },
          ),
        );
      }
      if (reservation.kind === "replay" && reservation.operation.status === "completed") {
        return mcpToolResultJson(JSON.parse(reservation.operation.resultJson ?? "{}"));
      }
      if (reservation.kind === "replay" && reservation.operation.status === "failed") {
        return yield* Effect.fail(
          new GatewayToolError(
            "operation_failed",
            "The original thread-creation operation failed; it will not create replacement threads.",
            {
              operationId: reservation.operation.operationId,
              error: reservation.operation.errorJson
                ? JSON.parse(reservation.operation.errorJson)
                : null,
            },
          ),
        );
      }
      if (reservation.kind === "replay" && reservation.operation.status !== "reserved") {
        return yield* awaitCreationReplay(operationId);
      }

      const claimed = yield* operationRepository
        .markDispatching({ operationId, now: gatewayIsoNow() })
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      if (!claimed) return yield* awaitCreationReplay(operationId);

      const createdThreads: Array<(typeof prepared)[number]> = [];
      const createdWorktrees: Array<{
        readonly cwd: string;
        readonly path: string;
        readonly branch: string;
        proof: {
          readonly token: string;
          readonly gitDir: string;
          readonly branch: string;
          readonly head: string;
        } | null;
      }> = [];

      const result = yield* Effect.forEach(
        prepared,
        (entry) =>
          Effect.gen(function* () {
            let branch: string | null = null;
            let worktreePath: string | null = null;
            if (entry.environment === "worktree") {
              const created = yield* git.createWorktree({
                cwd: entry.workspaceRoot,
                branch: entry.baseBranch!,
                newBranch: entry.newBranch!,
                path: entry.plannedWorktreePath,
              });
              branch = created.worktree.branch;
              worktreePath = created.worktree.path;
              const trackedWorktree = {
                cwd: entry.workspaceRoot,
                path: worktreePath,
                branch,
                proof: null as (typeof createdWorktrees)[number]["proof"],
              };
              createdWorktrees.push(trackedWorktree);
              const proof = yield* git.recordWorktreeOwnership({
                path: worktreePath,
                branch,
                token: randomUUID(),
              });
              trackedWorktree.proof = proof;
              const ownershipRecorded = yield* operationRepository.recordWorktreeCreated({
                operationId,
                index: entry.index,
                workspaceRoot: entry.workspaceRoot,
                path: worktreePath,
                branch,
                token: proof.token,
                gitDir: proof.gitDir,
                head: proof.head,
                now: gatewayIsoNow(),
              });
              if (!ownershipRecorded) {
                return yield* Effect.fail(
                  new Error(
                    `Could not persist ownership for created worktree ${worktreePath}; compensating it before dispatch.`,
                  ),
                );
              }
            }

            yield* orchestrationEngine.dispatch({
              type: "thread.create",
              commandId: entry.ids.threadCreateCommandId,
              threadId: entry.ids.threadId,
              projectId: entry.projectId,
              title: entry.title,
              modelSelection: entry.target,
              runtimeMode: entry.runtimeMode,
              interactionMode: "default",
              envMode: entry.environment,
              branch,
              worktreePath,
              creationSource: "synara_mcp",
              sourceThreadId: ThreadId.makeUnsafe(context.callerThreadId),
              sourceTurnId: TurnId.makeUnsafe(callerTurnId),
              gatewayOperationId: operationId,
              gatewayOperationIndex: entry.index,
              ...(worktreePath !== null
                ? {
                    associatedWorktreePath: worktreePath,
                    associatedWorktreeBranch: branch,
                    associatedWorktreeRef: branch,
                  }
                : {}),
              createdAt: gatewayIsoNow(),
            });
            createdThreads.push(entry);

            yield* orchestrationEngine.dispatch({
              type: "thread.turn.start",
              commandId: entry.ids.turnStartCommandId,
              threadId: entry.ids.threadId,
              message: {
                messageId: entry.ids.messageId,
                role: "user",
                text: entry.spec.prompt,
                attachments: [],
              },
              modelSelection: entry.target,
              dispatchMode: "queue",
              dispatchOrigin: "agent",
              runtimeMode: entry.runtimeMode,
              interactionMode: "default",
              createdAt: gatewayIsoNow(),
            });

            return {
              index: entry.index,
              threadId: entry.ids.threadId,
              projectId: entry.projectId,
              title: entry.title,
              target: entry.target,
              provider: entry.target.provider,
              model: entry.target.model,
              runtimeMode: entry.runtimeMode,
              environment: entry.environment,
              branch,
              worktreePath,
              status: "task_dispatched" as const,
            };
          }),
        { concurrency: 1 },
      ).pipe(
        Effect.flatMap((results) => {
          const result = {
            operationId,
            requestId: input.requestId,
            requestedCount: input.threads.length,
            createdCount: results.length,
            threadIds: results.map((entry) => entry.threadId),
            threads: results,
          } satisfies SynaraCreateThreadsResult;
          return operationRepository
            .complete({
              operationId,
              resultJson: JSON.stringify(result),
              now: gatewayIsoNow(),
            })
            .pipe(Effect.as(result));
        }),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* operationRepository
              .markCompensating({ operationId, now: gatewayIsoNow() })
              .pipe(Effect.catch(() => Effect.void));
            const compensationErrors: string[] = [];
            let compensatedThreadCount = 0;
            let compensatedWorktreeCount = 0;
            yield* Effect.forEach(
              [...createdThreads].reverse(),
              (entry) =>
                orchestrationEngine
                  .dispatch({
                    type: "thread.delete",
                    commandId: entry.ids.compensateCommandId,
                    threadId: entry.ids.threadId,
                  })
                  .pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        compensatedThreadCount += 1;
                      }),
                    ),
                    Effect.catch((error) =>
                      Effect.sync(() =>
                        compensationErrors.push(
                          `thread ${entry.ids.threadId}: ${errorText(error)}`,
                        ),
                      ),
                    ),
                  ),
              { discard: true },
            );
            yield* Effect.forEach(
              [...createdWorktrees].reverse(),
              (worktree) =>
                git
                  .withMutation(
                    worktree.cwd,
                    worktree.proof === null
                      ? git
                          .removeWorktree({
                            cwd: worktree.cwd,
                            path: worktree.path,
                            force: false,
                          })
                          .pipe(
                            Effect.flatMap(() =>
                              git.deleteBranch({
                                cwd: worktree.cwd,
                                branch: worktree.branch,
                                force: false,
                              }),
                            ),
                          )
                      : git
                          .verifyWorktreeOwnership({
                            path: worktree.path,
                            proof: worktree.proof,
                          })
                          .pipe(
                            Effect.flatMap((verification) =>
                              verification.verified
                                ? Effect.void
                                : Effect.fail(
                                    new Error(
                                      `Refusing live compensation: ${verification.reason ?? "ownership verification failed"}.`,
                                    ),
                                  ),
                            ),
                            Effect.flatMap(() =>
                              git.removeWorktree({
                                cwd: worktree.cwd,
                                path: worktree.path,
                                force: false,
                              }),
                            ),
                            Effect.flatMap(() =>
                              git.deleteBranchIfUnchanged({
                                cwd: worktree.cwd,
                                branch: worktree.branch,
                                expectedHead: worktree.proof!.head,
                              }),
                            ),
                          ),
                  )
                  .pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        compensatedWorktreeCount += 1;
                      }),
                    ),
                    Effect.catch((error) =>
                      Effect.sync(() =>
                        compensationErrors.push(`worktree ${worktree.path}: ${errorText(error)}`),
                      ),
                    ),
                  ),
              { discard: true },
            );
            const failure = {
              message: errorText(cause),
              createdThreadCount: createdThreads.length,
              compensatedThreadCount,
              compensatedWorktreeCount,
              compensationErrors,
            };
            if (compensationErrors.length > 0) {
              yield* operationRepository
                .recordCompensationFailure({
                  operationId,
                  errorJson: JSON.stringify(failure),
                  now: gatewayIsoNow(),
                })
                .pipe(Effect.catch(() => Effect.void));
              yield* Effect.logWarning("agent gateway compensation remains pending", {
                operationId,
                errors: compensationErrors,
              });
              return yield* Effect.fail(
                new GatewayToolError(
                  "operation_failed",
                  "Synara could not dispatch the exact creation plan and cleanup is still pending. The durable operation remains compensating and will never create replacements.",
                  { operationId, ...failure, compensationPending: true },
                ),
              );
            }
            yield* operationRepository
              .fail({
                operationId,
                errorJson: JSON.stringify(failure),
                now: gatewayIsoNow(),
              })
              .pipe(Effect.catch(() => Effect.void));
            return yield* Effect.fail(
              new GatewayToolError(
                "operation_failed",
                "Synara could not dispatch the exact creation plan. Created operation-owned resources were compensated; no replacements were created.",
                { operationId, ...failure },
              ),
            );
          }),
        ),
      );

      yield* appendThreadCreationRecap({
        callerThreadId: context.callerThreadId,
        callerTurnId,
        result,
      });
      return mcpToolResultJson(result);
    }).pipe(
      (effect) =>
        withCreationPlanLock(
          `${context.callerThreadId}\u0000${context.callerTurnId ?? "inactive"}`,
          effect,
        ),
      Effect.catch((error) =>
        Effect.succeed(
          error instanceof GatewayToolError || error instanceof AgentGatewayTargetError
            ? gatewayToolErrorResult(error)
            : mcpToolResultError(errorText(error)),
        ),
      ),
    );
  };

  return run;
});
