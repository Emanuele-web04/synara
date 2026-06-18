import { randomUUID } from "node:crypto";

import {
  AutomationId,
  AutomationRunId,
  CommandId,
  MessageId,
  ThreadId,
  type AutomationAllowedCapability,
  type AutomationDefinition,
  type AutomationRun,
  type AutomationRunNowResult,
  type AutomationRunStatus,
  type AutomationStreamEvent,
  type AutomationUpdateInput,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ThreadEnvironmentMode,
} from "@t3tools/contracts";
import { Effect, Layer, Option, PubSub, Stream } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import type { ProjectionTurn } from "../../persistence/Services/ProjectionTurns.ts";
import { AutomationServiceError } from "../Errors.ts";
import { AutomationService, type AutomationServiceShape } from "../Services/AutomationService.ts";
import { computeNextAutomationRunAt, computeNextAutomationRunAtAfter } from "../schedule.ts";

const AUTOMATION_ERROR_MAX_CHARS = 4_000;

/** Statuses a run can no longer leave; reconciliation never overwrites these. */
const TERMINAL_RUN_STATUSES: ReadonlySet<AutomationRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

function isTerminalRunStatus(status: AutomationRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

function isoNow(): string {
  return new Date().toISOString();
}

function makeAutomationId(): AutomationId {
  return AutomationId.makeUnsafe(`automation:${randomUUID()}`);
}

function makeAutomationRunId(): AutomationRunId {
  return AutomationRunId.makeUnsafe(`automation-run:${randomUUID()}`);
}

function deriveAutomationRunIds(runId: AutomationRunId) {
  return {
    threadId: ThreadId.makeUnsafe(`automation:${runId}:thread`),
    messageId: MessageId.makeUnsafe(`automation:${runId}:message`),
    threadCreateCommandId: CommandId.makeUnsafe(`automation:${runId}:thread-create`),
    turnStartCommandId: CommandId.makeUnsafe(`automation:${runId}:turn-start`),
  };
}

/** Redact common secret shapes before persisting/surfacing an automation error string. */
function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(
      /\b(authorization|bearer|token|api[_-]?key|secret|password)\b(\s*[=:]\s*|\s+)\S+/gi,
      "$1=[redacted]",
    );
}

function errorMessage(cause: unknown): string {
  const raw =
    cause instanceof Error && cause.message.trim().length > 0 ? cause.message : String(cause);
  return redactSecrets(raw).slice(0, AUTOMATION_ERROR_MAX_CHARS);
}

function toServiceError(message: string) {
  return (cause: unknown) => new AutomationServiceError({ message, cause });
}

function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function allowedCapabilitiesFor(definition: AutomationDefinition): AutomationAllowedCapability[] {
  const capabilities: AutomationAllowedCapability[] = ["send-turn"];
  if (definition.worktreeMode !== "local") {
    capabilities.push("create-worktree");
  }
  if (definition.runtimeMode === "full-access") {
    capabilities.push("full-access");
  }
  return capabilities;
}

function makePermissionSnapshot(definition: AutomationDefinition, now: string) {
  return {
    provider: definition.modelSelection.provider,
    modelSelection: definition.modelSelection,
    ...(definition.providerOptions ? { providerOptions: definition.providerOptions } : {}),
    runtimeMode: definition.runtimeMode,
    interactionMode: definition.interactionMode,
    worktreeMode: definition.worktreeMode,
    allowedCapabilities: allowedCapabilitiesFor(definition),
    createdAt: now,
  };
}

function mergeDefinitionUpdate(
  current: AutomationDefinition,
  input: AutomationUpdateInput,
  now: string,
): AutomationDefinition {
  const schedule = input.schedule ?? current.schedule;
  const nextRunAt =
    schedule.type === "manual"
      ? null
      : input.schedule
        ? computeNextAutomationRunAt(schedule, now)
        : (current.nextRunAt ?? computeNextAutomationRunAt(schedule, now));
  const providerOptions = input.providerOptions ?? current.providerOptions;
  const nextDefinition: AutomationDefinition = {
    ...current,
    projectId: input.projectId ?? current.projectId,
    sourceThreadId: hasOwn(input, "sourceThreadId")
      ? ((input.sourceThreadId as AutomationDefinition["sourceThreadId"] | undefined) ?? null)
      : current.sourceThreadId,
    name: input.name ?? current.name,
    prompt: input.prompt ?? current.prompt,
    schedule,
    enabled: input.enabled ?? current.enabled,
    nextRunAt,
    modelSelection: input.modelSelection ?? current.modelSelection,
    runtimeMode: input.runtimeMode ?? current.runtimeMode,
    interactionMode: input.interactionMode ?? current.interactionMode,
    worktreeMode: input.worktreeMode ?? current.worktreeMode,
    mode: input.mode ?? current.mode,
    targetThreadId: hasOwn(input, "targetThreadId")
      ? ((input.targetThreadId as AutomationDefinition["targetThreadId"] | undefined) ?? null)
      : current.targetThreadId,
    maxIterations: hasOwn(input, "maxIterations")
      ? ((input.maxIterations as AutomationDefinition["maxIterations"] | undefined) ?? null)
      : current.maxIterations,
    stopOnError: input.stopOnError ?? current.stopOnError,
    updatedAt: now,
  };

  return providerOptions ? { ...nextDefinition, providerOptions } : nextDefinition;
}

function makeAutomationBranchName(definition: AutomationDefinition, runId: AutomationRunId) {
  const nameSlug = definition.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const safeName = nameSlug.length > 0 ? nameSlug : "run";
  const suffix = runId
    .replace(/[^a-z0-9]+/gi, "-")
    .slice(-12)
    .toLowerCase();
  return `automation/${safeName}/${suffix}`;
}

type ThreadEnvironment = {
  readonly envMode: ThreadEnvironmentMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly associatedWorktreePath: string | null;
  readonly associatedWorktreeBranch: string | null;
  readonly associatedWorktreeRef: string | null;
};

const localThreadEnvironment: ThreadEnvironment = {
  envMode: "local",
  branch: null,
  worktreePath: null,
  associatedWorktreePath: null,
  associatedWorktreeBranch: null,
  associatedWorktreeRef: null,
};

const SCHEDULER_LEASE_TTL_MS = 120_000;

export const AutomationServiceLive = Layer.effect(
  AutomationService,
  Effect.gen(function* () {
    const automationRepository = yield* AutomationRepository;
    const git = yield* GitCore;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    // Unbounded so we never silently drop run/definition updates under a burst, matching
    // the rest of the server's PubSub usage.
    const events = yield* PubSub.unbounded<AutomationStreamEvent>();

    const publish = (event: AutomationStreamEvent) =>
      PubSub.publish(events, event).pipe(Effect.asVoid);

    const requireDefinition = (id: AutomationId) =>
      automationRepository.getDefinitionById({ id }).pipe(
        Effect.mapError(toServiceError("Failed to load automation.")),
        Effect.flatMap((definitionOption) =>
          Option.match(definitionOption, {
            onNone: () =>
              Effect.fail(new AutomationServiceError({ message: "Automation was not found." })),
            onSome: (definition) =>
              definition.archivedAt
                ? Effect.fail(
                    new AutomationServiceError({ message: "Automation has been deleted." }),
                  )
                : Effect.succeed(definition),
          }),
        ),
      );

    const publishDefinition = (id: AutomationId) =>
      automationRepository.getDefinitionById({ id }).pipe(
        Effect.mapError(toServiceError("Failed to load automation.")),
        Effect.flatMap((definitionOption) =>
          Option.match(definitionOption, {
            onNone: () => Effect.void,
            onSome: (definition) => publish({ type: "definition-upserted", definition }),
          }),
        ),
      );

    const requireProject = (projectId: AutomationDefinition["projectId"]) =>
      projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.mapError(toServiceError("Failed to load project snapshot.")),
        Effect.flatMap((snapshot) => {
          const project = snapshot.projects.find((entry) => entry.id === projectId);
          return project
            ? Effect.succeed(project)
            : Effect.fail(
                new AutomationServiceError({ message: "Automation project was not found." }),
              );
        }),
      );

    const validateHeartbeatTarget = (input: {
      readonly mode: AutomationDefinition["mode"];
      readonly projectId: AutomationDefinition["projectId"];
      readonly targetThreadId: AutomationDefinition["targetThreadId"];
    }) => {
      if (input.mode !== "heartbeat") {
        return Effect.void;
      }
      if (!input.targetThreadId) {
        return Effect.fail(
          new AutomationServiceError({ message: "Heartbeat automations require a target thread." }),
        );
      }
      return projectionSnapshotQuery.getThreadShellById(input.targetThreadId).pipe(
        Effect.mapError(toServiceError("Failed to load heartbeat target thread.")),
        Effect.flatMap((threadOption) =>
          Option.match(threadOption, {
            onNone: () =>
              Effect.fail(
                new AutomationServiceError({
                  message: "Heartbeat target thread was not found.",
                }),
              ),
            onSome: (thread) =>
              thread.projectId === input.projectId
                ? Effect.void
                : Effect.fail(
                    new AutomationServiceError({
                      message: "Heartbeat target thread must belong to the automation project.",
                    }),
                  ),
          }),
        ),
      );
    };

    const resolveThreadEnvironment = (
      definition: AutomationDefinition,
      project: OrchestrationProjectShell,
      runId: AutomationRunId,
    ): Effect.Effect<ThreadEnvironment, AutomationServiceError> => {
      if (definition.worktreeMode === "local") {
        return Effect.succeed(localThreadEnvironment);
      }

      return git.statusDetails(project.workspaceRoot).pipe(
        Effect.mapError(toServiceError("Failed to inspect project Git status.")),
        Effect.flatMap((status) => {
          if (!status.isRepo || !status.branch) {
            return definition.worktreeMode === "worktree"
              ? Effect.fail(
                  new AutomationServiceError({
                    message:
                      "Automation requires a Git worktree, but the project is not on a branch.",
                  }),
                )
              : Effect.succeed(localThreadEnvironment);
          }

          const branch = makeAutomationBranchName(definition, runId);
          return git
            .createWorktree({
              cwd: project.workspaceRoot,
              branch: status.branch,
              newBranch: branch,
              path: null,
            })
            .pipe(
              Effect.mapError(toServiceError("Failed to create automation worktree.")),
              Effect.map(
                (result): ThreadEnvironment => ({
                  envMode: "worktree",
                  branch: result.worktree.branch,
                  worktreePath: result.worktree.path,
                  associatedWorktreePath: result.worktree.path,
                  associatedWorktreeBranch: result.worktree.branch,
                  associatedWorktreeRef: result.worktree.branch,
                }),
              ),
            );
        }),
        Effect.catch((error) =>
          definition.worktreeMode === "auto"
            ? Effect.succeed(localThreadEnvironment)
            : Effect.fail(error),
        ),
      );
    };

    const runUsesExistingThread = (run: AutomationRun) => run.threadCreateCommandId === null;

    // Heartbeat runs reuse busy user threads, so reconcile only against the turn created
    // from this run's stored message id; the shell's latest turn may belong to someone else.
    const resolveRunTurn = (
      run: AutomationRun,
      shell: OrchestrationThreadShell,
    ): Effect.Effect<ProjectionTurn | OrchestrationThreadShell["latestTurn"] | null> => {
      if (!runUsesExistingThread(run)) {
        return Effect.succeed(shell.latestTurn);
      }
      if (!run.threadId || !run.messageId) {
        return Effect.succeed(null);
      }
      if (run.turnId) {
        return projectionTurnRepository
          .getByTurnId({ threadId: run.threadId, turnId: run.turnId })
          .pipe(
            Effect.mapError(toServiceError("Failed to load automation turn.")),
            Effect.map((turnOption) =>
              Option.match(turnOption, {
                onNone: () => null,
                onSome: (turn) => turn,
              }),
            ),
          );
      }
      return projectionTurnRepository.listByThreadId({ threadId: run.threadId }).pipe(
        Effect.mapError(toServiceError("Failed to list automation turns.")),
        Effect.map(
          (turns) => turns.find((turn) => turn.pendingMessageId === run.messageId) ?? null,
        ),
      );
    };

    const runTurnOwnsPendingInput = (
      run: AutomationRun,
      shell: OrchestrationThreadShell,
      turn: ProjectionTurn | OrchestrationThreadShell["latestTurn"] | null,
    ) =>
      !runUsesExistingThread(run) ||
      (turn?.turnId !== null &&
        turn?.turnId !== undefined &&
        shell.latestTurn?.turnId === turn.turnId);

    // Dispatch a run: standalone creates a fresh thread + turn; heartbeat continues the
    // configured target thread with a new turn. A failure marks the run failed before
    // re-raising so the scheduler/caller still observes the error.
    const dispatchRun = (
      definition: AutomationDefinition,
      run: AutomationRun,
      now: string,
    ): Effect.Effect<AutomationRunNowResult, AutomationServiceError> => {
      const ids = deriveAutomationRunIds(run.id);
      return Effect.gen(function* () {
        if (definition.mode === "heartbeat") {
          const targetThreadId = definition.targetThreadId;
          if (!targetThreadId) {
            return yield* Effect.fail(
              new AutomationServiceError({
                message: "Heartbeat automation has no target thread to continue.",
              }),
            );
          }

          yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.start",
              commandId: ids.turnStartCommandId,
              threadId: targetThreadId,
              message: {
                messageId: ids.messageId,
                role: "user",
                text: definition.prompt,
                attachments: [],
              },
              modelSelection: definition.modelSelection,
              ...(definition.providerOptions
                ? { providerOptions: definition.providerOptions }
                : {}),
              dispatchMode: "queue",
              runtimeMode: definition.runtimeMode,
              interactionMode: definition.interactionMode,
              createdAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to continue automation thread.")));

          const started = yield* automationRepository
            .markRunStarted({
              id: run.id,
              threadId: targetThreadId,
              messageId: ids.messageId,
              threadCreateCommandId: null,
              turnStartCommandId: ids.turnStartCommandId,
              startedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
          yield* publish({ type: "run-upserted", run: started });
          return { run: started };
        }

        const project = yield* requireProject(definition.projectId);
        const environment = yield* resolveThreadEnvironment(definition, project, run.id);

        yield* orchestrationEngine
          .dispatch({
            type: "thread.create",
            commandId: ids.threadCreateCommandId,
            threadId: ids.threadId,
            projectId: definition.projectId,
            title: `${definition.name} - ${now}`,
            modelSelection: definition.modelSelection,
            runtimeMode: definition.runtimeMode,
            interactionMode: definition.interactionMode,
            envMode: environment.envMode,
            branch: environment.branch,
            worktreePath: environment.worktreePath,
            associatedWorktreePath: environment.associatedWorktreePath,
            associatedWorktreeBranch: environment.associatedWorktreeBranch,
            associatedWorktreeRef: environment.associatedWorktreeRef,
            createdAt: now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to create automation thread.")));

        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.start",
            commandId: ids.turnStartCommandId,
            threadId: ids.threadId,
            message: {
              messageId: ids.messageId,
              role: "user",
              text: definition.prompt,
              attachments: [],
            },
            modelSelection: definition.modelSelection,
            ...(definition.providerOptions ? { providerOptions: definition.providerOptions } : {}),
            dispatchMode: "queue",
            runtimeMode: definition.runtimeMode,
            interactionMode: definition.interactionMode,
            createdAt: now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to start automation turn.")));

        const started = yield* automationRepository
          .markRunStarted({
            id: run.id,
            threadId: ids.threadId,
            messageId: ids.messageId,
            threadCreateCommandId: ids.threadCreateCommandId,
            turnStartCommandId: ids.turnStartCommandId,
            startedAt: now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
        yield* publish({ type: "run-upserted", run: started });
        return { run: started };
      }).pipe(
        Effect.catch((error) =>
          automationRepository
            .markRunFailed({
              id: run.id,
              error: errorMessage(error),
              finishedAt: isoNow(),
            })
            .pipe(
              Effect.tap((failed) => publish({ type: "run-upserted", run: failed })),
              Effect.ignore,
              Effect.flatMap(() => Effect.fail(error)),
            ),
        ),
      );
    };

    const normalizeCreatedDefinitionSchedule = (definition: AutomationDefinition, now: string) => {
      const nextRunAt = computeNextAutomationRunAt(definition.schedule, now);
      if (definition.nextRunAt === nextRunAt) {
        return Effect.succeed(definition);
      }
      return automationRepository.saveDefinition({
        ...definition,
        nextRunAt,
        updatedAt: now,
      });
    };

    // Create + persist a pending run and return whether it was a fresh insert. Scheduled
    // occurrences dedupe via INSERT OR IGNORE on (automationId, scheduledFor), so createRun
    // may return a pre-existing row (inserted === false); callers count + dispatch only
    // fresh runs, and the schedule is only advanced once the run has durably succeeded.
    const createPendingRun = (
      definition: AutomationDefinition,
      trigger: AutomationRun["trigger"],
      scheduledFor: string,
      now: string,
    ) =>
      Effect.gen(function* () {
        const threadId = definition.mode === "heartbeat" ? definition.targetThreadId : null;
        const runId = makeAutomationRunId();
        const run = yield* automationRepository
          .createRun({
            id: runId,
            automationId: definition.id,
            projectId: definition.projectId,
            threadId,
            trigger,
            scheduledFor,
            permissionSnapshot: makePermissionSnapshot(definition, now),
            now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to create automation run.")));
        yield* publish({ type: "run-upserted", run });
        return { run, inserted: run.id === runId };
      });

    const maybeStopLoop = (automationId: AutomationId, status: AutomationRunStatus, now: string) =>
      automationRepository.getDefinitionById({ id: automationId }).pipe(
        Effect.mapError(toServiceError("Failed to load automation.")),
        Effect.flatMap((definitionOption) =>
          Option.match(definitionOption, {
            onNone: () => Effect.void,
            onSome: (definition) => {
              if (definition.archivedAt || !definition.enabled) {
                return Effect.void;
              }
              const stopOnError = status === "failed" && definition.stopOnError;
              const reachedMax =
                definition.maxIterations !== null &&
                definition.iterationCount >= definition.maxIterations;
              if (!stopOnError && !reachedMax) {
                return Effect.void;
              }
              return automationRepository.disableDefinition({ id: automationId, now }).pipe(
                Effect.mapError(toServiceError("Failed to disable automation.")),
                Effect.flatMap(() => publishDefinition(automationId)),
              );
            },
          }),
        ),
      );

    const reconcileThread: AutomationServiceShape["reconcileThread"] = ({ threadId }) =>
      Effect.gen(function* () {
        const runOption = yield* automationRepository
          .getRunByThreadId({ threadId })
          .pipe(Effect.mapError(toServiceError("Failed to load automation run for thread.")));
        if (Option.isNone(runOption)) {
          return;
        }
        const run = runOption.value;
        if (isTerminalRunStatus(run.status)) {
          return;
        }

        const shellOption = yield* projectionSnapshotQuery
          .getThreadShellById(threadId)
          .pipe(Effect.mapError(toServiceError("Failed to load automation thread state.")));
        if (Option.isNone(shellOption)) {
          return;
        }
        const shell = shellOption.value;
        const turn = yield* resolveRunTurn(run, shell);
        const now = isoNow();

        if (
          (shell.hasPendingApprovals === true || shell.hasPendingUserInput === true) &&
          runTurnOwnsPendingInput(run, shell, turn)
        ) {
          if (run.status !== "waiting-for-approval") {
            const updated = yield* automationRepository
              .markRunWaitingForApproval({
                id: run.id,
                turnId: turn?.turnId ?? null,
                updatedAt: now,
              })
              .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
            yield* publish({ type: "run-upserted", run: updated });
          }
          return;
        }

        if (!turn || turn.turnId === null || turn.state === "pending" || turn.state === "running") {
          return;
        }

        let updated: AutomationRun;
        if (turn.state === "completed") {
          updated = yield* automationRepository
            .markRunSucceeded({
              id: run.id,
              turnId: turn.turnId,
              result: null,
              finishedAt: turn.completedAt ?? now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
        } else if (turn.state === "error") {
          updated = yield* automationRepository
            .markRunFailed({
              id: run.id,
              error: errorMessage(shell.session?.lastError ?? "Automation turn failed."),
              finishedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
        } else {
          updated = yield* automationRepository
            .markRunInterrupted({
              id: run.id,
              turnId: turn.turnId,
              finishedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
        }

        yield* publish({ type: "run-upserted", run: updated });
        yield* maybeStopLoop(run.automationId, updated.status, now);
      });

    const reconcileActiveRuns: AutomationServiceShape["reconcileActiveRuns"] = () =>
      automationRepository.listRecoverableRuns({ limit: 100 }).pipe(
        Effect.mapError(toServiceError("Failed to list active automation runs.")),
        Effect.flatMap((runs) =>
          Effect.forEach(
            runs,
            (run) =>
              run.threadId
                ? reconcileThread({ threadId: run.threadId }).pipe(Effect.catch(() => Effect.void))
                : Effect.void,
            { concurrency: 1 },
          ),
        ),
        Effect.asVoid,
      );

    const recoverPendingRuns: AutomationServiceShape["recoverPendingRuns"] = () =>
      automationRepository.listRecoverableRuns({ limit: 200 }).pipe(
        Effect.mapError(toServiceError("Failed to list recoverable automation runs.")),
        Effect.flatMap((runs) =>
          Effect.forEach(
            runs,
            (run) => {
              const now = isoNow();
              const threadId = run.threadId;
              if (!threadId) {
                // Orphaned before any thread was created (crash between create and dispatch).
                return automationRepository
                  .markRunInterrupted({ id: run.id, turnId: null, finishedAt: now })
                  .pipe(
                    Effect.tap((updated) => publish({ type: "run-upserted", run: updated })),
                    Effect.mapError(toServiceError("Failed to recover automation run.")),
                    Effect.asVoid,
                    Effect.catch(() => Effect.void),
                  );
              }
              return projectionSnapshotQuery.getThreadShellById(threadId).pipe(
                Effect.mapError(toServiceError("Failed to load automation thread state.")),
                Effect.flatMap((shellOption) =>
                  Option.isNone(shellOption)
                    ? automationRepository
                        .markRunInterrupted({ id: run.id, turnId: null, finishedAt: now })
                        .pipe(
                          Effect.tap((updated) => publish({ type: "run-upserted", run: updated })),
                          Effect.mapError(toServiceError("Failed to recover automation run.")),
                          Effect.asVoid,
                        )
                    : reconcileThread({ threadId }),
                ),
                Effect.catch(() => Effect.void),
              );
            },
            { concurrency: 1 },
          ),
        ),
        Effect.asVoid,
      );

    const list: AutomationServiceShape["list"] = (input = {}) =>
      automationRepository
        .list(input)
        .pipe(Effect.mapError(toServiceError("Failed to list automations.")));

    const create: AutomationServiceShape["create"] = (input) =>
      Effect.gen(function* () {
        yield* validateHeartbeatTarget({
          mode: input.mode ?? "standalone",
          projectId: input.projectId,
          targetThreadId: input.targetThreadId ?? null,
        });
        const now = isoNow();
        const definition = yield* automationRepository
          .createDefinition({ id: makeAutomationId(), input, now })
          .pipe(Effect.mapError(toServiceError("Failed to create automation.")));
        const normalized = yield* normalizeCreatedDefinitionSchedule(definition, now).pipe(
          Effect.mapError(toServiceError("Failed to initialize automation schedule.")),
        );
        yield* publish({ type: "definition-upserted", definition: normalized });
        return normalized;
      });

    const update: AutomationServiceShape["update"] = (input) =>
      Effect.gen(function* () {
        const current = yield* requireDefinition(input.id);
        const updated = mergeDefinitionUpdate(current, input, isoNow());
        yield* validateHeartbeatTarget(updated);
        const saved = yield* automationRepository
          .saveDefinition(updated)
          .pipe(Effect.mapError(toServiceError("Failed to update automation.")));
        yield* publish({ type: "definition-upserted", definition: saved });
        return saved;
      });

    const deleteAutomation: AutomationServiceShape["delete"] = (input) =>
      automationRepository.archiveDefinition({ id: input.id, archivedAt: isoNow() }).pipe(
        Effect.mapError(toServiceError("Failed to delete automation.")),
        Effect.tap(() => publish({ type: "definition-deleted", automationId: input.id })),
      );

    const runNow: AutomationServiceShape["runNow"] = (input) =>
      Effect.gen(function* () {
        const definition = yield* requireDefinition(input.automationId);
        // Heartbeat automations continue a single shared thread, so a manual run must not
        // race a scheduled (or earlier manual) run that is still in flight. Standalone
        // automations spawn independent threads, so concurrent manual runs are fine.
        if (definition.mode === "heartbeat") {
          const activeRuns = yield* automationRepository
            .countActiveRunsForDefinition({ automationId: definition.id })
            .pipe(Effect.mapError(toServiceError("Failed to count active automation runs.")));
          if (activeRuns > 0) {
            return yield* Effect.fail(
              new AutomationServiceError({
                message:
                  "This loop already has a run in progress. Wait for it to finish before running again.",
              }),
            );
          }
        }
        const now = isoNow();
        const { run, inserted } = yield* createPendingRun(definition, { type: "manual" }, now, now);
        if (inserted) {
          yield* automationRepository
            .incrementDefinitionIterationCount({ id: definition.id, now })
            .pipe(Effect.mapError(toServiceError("Failed to update automation iteration count.")));
        }
        return yield* dispatchRun(definition, run, now);
      });

    const cancelRun: AutomationServiceShape["cancelRun"] = (input) =>
      automationRepository.cancelRun({ ...input, now: isoNow() }).pipe(
        Effect.mapError(toServiceError("Failed to cancel automation run.")),
        Effect.tap((run) => publish({ type: "run-upserted", run })),
        Effect.map((run) => ({ run })),
      );

    // Run one due definition: enforce the iteration cap, skip when a prior run is still in
    // flight, create the run durably, advance the schedule (coalescing missed slots), then
    // dispatch. A dispatch failure still leaves a recorded failed run.
    const runDueDefinition = (definition: AutomationDefinition, now: string) =>
      Effect.gen(function* () {
        if (
          definition.maxIterations !== null &&
          definition.iterationCount >= definition.maxIterations
        ) {
          yield* automationRepository
            .disableDefinition({ id: definition.id, now })
            .pipe(Effect.mapError(toServiceError("Failed to disable automation.")));
          yield* publishDefinition(definition.id);
          return Option.none<AutomationRunNowResult>();
        }

        const scheduledFor = definition.nextRunAt ?? now;
        const nextRunAt = computeNextAutomationRunAtAfter(definition.schedule, scheduledFor, now);

        const activeRuns = yield* automationRepository
          .countActiveRunsForDefinition({ automationId: definition.id })
          .pipe(Effect.mapError(toServiceError("Failed to count active automation runs.")));
        if (activeRuns > 0) {
          // A previous run is still in flight; skip this occurrence and advance the schedule
          // so the loop does not pile up concurrent runs on the same automation.
          yield* automationRepository
            .setDefinitionNextRunAt({ id: definition.id, nextRunAt, updatedAt: now })
            .pipe(Effect.mapError(toServiceError("Failed to advance automation schedule.")));
          yield* publishDefinition(definition.id);
          return Option.none<AutomationRunNowResult>();
        }

        const { run, inserted } = yield* createPendingRun(
          definition,
          { type: "scheduled" },
          scheduledFor,
          now,
        );
        // The run is now durable, so it is safe to advance the schedule even if dispatch fails.
        yield* automationRepository
          .setDefinitionNextRunAt({ id: definition.id, nextRunAt, updatedAt: now })
          .pipe(Effect.mapError(toServiceError("Failed to advance automation schedule.")));
        yield* publishDefinition(definition.id);

        if (!inserted) {
          // This scheduled occurrence already had a durable row (e.g. a run interrupted by a
          // crash before the schedule advanced). Don't re-dispatch or double-count it; the
          // occurrence is already recorded and the schedule has now moved past it.
          return Option.none<AutomationRunNowResult>();
        }

        yield* automationRepository
          .incrementDefinitionIterationCount({ id: definition.id, now })
          .pipe(Effect.mapError(toServiceError("Failed to update automation iteration count.")));

        const result = yield* dispatchRun(definition, run, now).pipe(
          Effect.catch(() =>
            automationRepository.getRunById({ id: run.id }).pipe(
              Effect.mapError(toServiceError("Failed to load automation run.")),
              Effect.map((runOption) =>
                Option.match(runOption, {
                  onNone: (): AutomationRunNowResult => ({ run }),
                  onSome: (failed): AutomationRunNowResult => ({ run: failed }),
                }),
              ),
            ),
          ),
        );
        return Option.some(result);
      });

    const runDueOnce: AutomationServiceShape["runDueOnce"] = (input = {}) =>
      Effect.gen(function* () {
        const now = input.now ?? isoNow();
        const ownerId = input.leaseOwnerId ?? `automation-scheduler:${process.pid}`;
        const nowMs = Date.parse(now);
        const leaseExpiresAt = new Date(
          (Number.isFinite(nowMs) ? nowMs : Date.now()) + SCHEDULER_LEASE_TTL_MS,
        ).toISOString();
        const acquired = yield* automationRepository
          .tryAcquireSchedulerLease({
            leaseKey: "automation-scheduler",
            ownerId,
            now,
            leaseExpiresAt,
          })
          .pipe(Effect.mapError(toServiceError("Failed to acquire automation scheduler lease.")));
        if (!acquired) {
          return [];
        }

        const definitions = yield* automationRepository
          .listDueDefinitions({
            now,
            limit: input.limit ?? 5,
          })
          .pipe(Effect.mapError(toServiceError("Failed to list due automations.")));

        const results = yield* Effect.forEach(
          definitions,
          (definition) =>
            runDueDefinition(definition, now).pipe(
              Effect.catch((error) =>
                Effect.logWarning("automation scheduled run failed", {
                  automationId: definition.id,
                  error: errorMessage(error),
                }).pipe(Effect.as(Option.none<AutomationRunNowResult>())),
              ),
            ),
          { concurrency: 1 },
        );

        return results.filter(Option.isSome).map((result) => result.value);
      });

    return {
      list,
      create,
      update,
      delete: deleteAutomation,
      runNow,
      cancelRun,
      runDueOnce,
      reconcileThread,
      reconcileActiveRuns,
      recoverPendingRuns,
      streamEvents: Stream.fromPubSub(events),
    } satisfies AutomationServiceShape;
  }),
);
