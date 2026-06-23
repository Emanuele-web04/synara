import { randomUUID } from "node:crypto";

import {
  AutomationId,
  AutomationRunId,
  CommandId,
  DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS,
  DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS,
  MessageId,
  ThreadId,
  type AutomationAllowedCapability,
  type AutomationCompletionPolicy,
  type AutomationDefinition,
  type AutomationRun,
  type AutomationRunResult,
  type AutomationRunNowResult,
  type AutomationRunStatus,
  type AutomationStreamEvent,
  type AutomationUpdateInput,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ThreadEnvironmentMode,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, PubSub, Queue, Stream } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { resolveTextGenerationInputForSelection } from "../../git/textGenerationSelection.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import type { ProjectionTurn } from "../../persistence/Services/ProjectionTurns.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AutomationServiceError } from "../Errors.ts";
import { AutomationService, type AutomationServiceShape } from "../Services/AutomationService.ts";
import {
  type AutomationCompletionEvaluation,
  automationCompletionRunResult,
  automationRunResultSummary,
  failedAutomationCompletionEvaluation,
  normalizeAutomationCompletionReason,
} from "../runResult.ts";
import {
  computeAutomationScheduleSpacingSeconds,
  computeNextAutomationRunAt,
  computeNextAutomationRunAtAfter,
} from "../schedule.ts";

const AUTOMATION_ERROR_MAX_CHARS = 4_000;
const FAST_INTERVAL_ACKNOWLEDGED_MINIMUM_SECONDS = 1;
const AUTOMATION_COMPLETION_EVALUATION_WORKERS = 2;
const AUTOMATION_COMPLETION_EVALUATION_QUEUE_CAPACITY = 100;

interface AutomationCompletionEvaluationJob {
  readonly definition: AutomationDefinition;
  readonly run: AutomationRun;
  readonly policy: Extract<AutomationCompletionPolicy, { type: "ai-evaluated" }>;
}

/** Statuses a run can no longer leave; reconciliation never overwrites these. */
const TERMINAL_RUN_STATUSES: ReadonlySet<AutomationRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
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

function makeAutomationCommandId(runId: AutomationRunId, suffix: string): CommandId {
  return CommandId.makeUnsafe(`automation:${runId}:${suffix}`);
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

function resultSummary(value: string | null | undefined, fallback?: string): string | null {
  return automationRunResultSummary(value, fallback);
}

function completionFailureReason(error: unknown): string {
  const message = error instanceof AutomationServiceError ? error.message : errorMessage(error);
  return normalizeAutomationCompletionReason(`Stop check failed: ${message}`);
}

function isSameAiCompletionPolicy(
  left: Extract<AutomationCompletionPolicy, { type: "ai-evaluated" }>,
  right: Extract<AutomationCompletionPolicy, { type: "ai-evaluated" }>,
): boolean {
  return left.stopWhen === right.stopWhen && left.confidenceThreshold === right.confidenceThreshold;
}

function isSameCompletionPolicy(
  left: AutomationCompletionPolicy,
  right: AutomationCompletionPolicy,
): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "none") {
    return true;
  }
  return right.type === "ai-evaluated" && isSameAiCompletionPolicy(left, right);
}

const DEFAULT_COMPLETION_POLICY = { type: "none" } as const satisfies AutomationCompletionPolicy;

function completionPolicyForDefinition(
  definition: AutomationDefinition,
): AutomationCompletionPolicy {
  return definition.completionPolicy ?? DEFAULT_COMPLETION_POLICY;
}

function completionPolicyVersionForDefinition(definition: AutomationDefinition): number {
  return definition.completionPolicyVersion ?? 1;
}

function completionPolicyUpdatedAtForDefinition(definition: AutomationDefinition): string {
  return definition.completionPolicyUpdatedAt ?? definition.createdAt;
}

function runUsesCurrentCompletionPolicy(
  run: AutomationRun,
  definition: AutomationDefinition,
): boolean {
  if (run.permissionSnapshot.completionPolicyVersion !== undefined) {
    return (
      run.permissionSnapshot.completionPolicyVersion ===
      completionPolicyVersionForDefinition(definition)
    );
  }
  const runPolicyAnchorMs = Date.parse(run.startedAt ?? run.createdAt);
  const policyUpdatedAtMs = Date.parse(completionPolicyUpdatedAtForDefinition(definition));
  return (
    Number.isFinite(runPolicyAnchorMs) &&
    Number.isFinite(policyUpdatedAtMs) &&
    runPolicyAnchorMs > policyUpdatedAtMs
  );
}

function resultForRunStatus(
  status: AutomationRunStatus,
  input: { readonly summary?: string | null; readonly now: string },
): AutomationRunResult | null {
  switch (status) {
    case "succeeded":
      return {
        outcome: "unknown",
        summary: resultSummary(input.summary),
        unread: true,
        archivedAt: null,
      };
    case "failed":
    case "interrupted":
    case "cancelled":
    case "waiting-for-approval":
      return {
        outcome: "needs-attention",
        summary: resultSummary(input.summary, "Automation run needs attention."),
        severity: status === "failed" ? "error" : "warning",
        unread: true,
        archivedAt: null,
      };
    case "skipped":
      return {
        outcome: "no-findings",
        summary: resultSummary(input.summary, "Run skipped."),
        severity: "info",
        unread: false,
        archivedAt: input.now,
      };
    case "pending":
    case "claimed":
    case "running":
      return null;
  }
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
    completionPolicyVersion: completionPolicyVersionForDefinition(definition),
    runtimeMode: definition.runtimeMode,
    interactionMode: definition.interactionMode,
    worktreeMode: definition.worktreeMode,
    allowedCapabilities: allowedCapabilitiesFor(definition),
    createdAt: now,
  };
}

function safeComputeNextRunAt(
  schedule: AutomationDefinition["schedule"],
  now: string,
  fallback: string | null,
) {
  try {
    return computeNextAutomationRunAt(schedule, now);
  } catch {
    return fallback;
  }
}

function effectiveMinimumIntervalSeconds(input: {
  readonly minimumIntervalSeconds: number;
  readonly acknowledgedRisks: readonly string[];
}): number {
  if (
    input.acknowledgedRisks.includes("fast-interval") &&
    input.minimumIntervalSeconds === DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS
  ) {
    return FAST_INTERVAL_ACKNOWLEDGED_MINIMUM_SECONDS;
  }
  return input.minimumIntervalSeconds;
}

function riskAcknowledgementError(input: {
  readonly runtimeMode: AutomationDefinition["runtimeMode"];
  readonly worktreeMode: AutomationDefinition["worktreeMode"];
  readonly acknowledgedRisks: readonly string[];
}): string | null {
  const acknowledgedRisks = new Set(input.acknowledgedRisks);
  if (input.runtimeMode === "full-access" && !acknowledgedRisks.has("full-access")) {
    return "Automation full-access mode requires an explicit acknowledgement.";
  }
  if (input.worktreeMode === "local" && !acknowledgedRisks.has("local-checkout")) {
    return "Automation local checkout mode requires an explicit acknowledgement.";
  }
  return null;
}

function isBeforeIso(value: string, comparison: string): boolean {
  const valueMs = Date.parse(value);
  const comparisonMs = Date.parse(comparison);
  return Number.isFinite(valueMs) && Number.isFinite(comparisonMs) && valueMs < comparisonMs;
}

function hasExceededMaxRuntime(
  definition: AutomationDefinition,
  run: AutomationRun,
  now: string,
): boolean {
  if (definition.maxRuntimeSeconds === null || run.startedAt === null) {
    return false;
  }
  const startedAtMs = Date.parse(run.startedAt);
  const nowMs = Date.parse(now);
  return (
    Number.isFinite(startedAtMs) &&
    Number.isFinite(nowMs) &&
    nowMs - startedAtMs >= definition.maxRuntimeSeconds * 1000
  );
}

function runUsesExistingThread(run: AutomationRun): boolean {
  return run.threadCreateCommandId === null;
}

function scheduledOccurrenceForDefinition(definition: AutomationDefinition, now: string) {
  const plannedScheduledFor = definition.nextRunAt ?? now;
  const missed = isBeforeIso(plannedScheduledFor, now);
  const scheduledFor =
    missed && definition.misfirePolicy === "run-latest" ? now : plannedScheduledFor;
  const nextRunAt = computeNextAutomationRunAtAfter(definition.schedule, scheduledFor, now);
  return {
    scheduledFor,
    nextRunAt,
    skip: missed && definition.misfirePolicy === "skip",
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
        ? safeComputeNextRunAt(schedule, now, current.nextRunAt)
        : (current.nextRunAt ?? safeComputeNextRunAt(schedule, now, null));
  const providerOptions = input.providerOptions ?? current.providerOptions;
  const mode = input.mode ?? current.mode;
  const currentCompletionPolicy = completionPolicyForDefinition(current);
  const completionPolicy =
    mode === "standalone"
      ? { type: "none" as const }
      : (input.completionPolicy ?? currentCompletionPolicy);
  const completionPolicyChanged = !isSameCompletionPolicy(
    currentCompletionPolicy,
    completionPolicy,
  );
  // Run caps apply to both standalone and heartbeat definitions; chat parsing uses
  // them for bounded requests like "every 15 seconds for 3 times".
  const maxIterations = hasOwn(input, "maxIterations")
    ? ((input.maxIterations as AutomationDefinition["maxIterations"] | undefined) ?? null)
    : current.maxIterations;
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
    mode,
    targetThreadId: hasOwn(input, "targetThreadId")
      ? ((input.targetThreadId as AutomationDefinition["targetThreadId"] | undefined) ?? null)
      : current.targetThreadId,
    maxIterations,
    stopOnError: input.stopOnError ?? current.stopOnError,
    completionPolicy,
    completionPolicyVersion: completionPolicyChanged
      ? completionPolicyVersionForDefinition(current) + 1
      : completionPolicyVersionForDefinition(current),
    completionPolicyUpdatedAt: completionPolicyChanged
      ? now
      : completionPolicyUpdatedAtForDefinition(current),
    minimumIntervalSeconds: input.minimumIntervalSeconds ?? current.minimumIntervalSeconds,
    maxRuntimeSeconds: hasOwn(input, "maxRuntimeSeconds")
      ? ((input.maxRuntimeSeconds as AutomationDefinition["maxRuntimeSeconds"] | undefined) ?? null)
      : current.maxRuntimeSeconds,
    retryPolicy: input.retryPolicy ?? current.retryPolicy,
    misfirePolicy: input.misfirePolicy ?? current.misfirePolicy,
    acknowledgedRisks: input.acknowledgedRisks ?? current.acknowledgedRisks,
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
    const textGeneration = yield* TextGeneration;
    const serverSettings = yield* ServerSettingsService;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    // Unbounded so we never silently drop run/definition updates under a burst, matching
    // the rest of the server's PubSub usage.
    const events = yield* PubSub.unbounded<AutomationStreamEvent>();
    // Stop-condition AI calls can be slow; cap queued+active jobs and let DB
    // reconciliation rediscover excess pending rows when worker capacity frees up.
    const completionEvaluationQueue = yield* Queue.bounded<AutomationCompletionEvaluationJob>(
      AUTOMATION_COMPLETION_EVALUATION_QUEUE_CAPACITY,
    );
    const queuedCompletionEvaluationRunIds = new Set<string>();

    const publish = (event: AutomationStreamEvent) =>
      PubSub.publish(events, event).pipe(Effect.asVoid);

    const cleanupUnattachedWorktree = (input: {
      readonly definition: AutomationDefinition;
      readonly run: AutomationRun;
      readonly project: OrchestrationProjectShell;
      readonly environment: ThreadEnvironment;
      readonly reason: string;
    }) => {
      const path = input.environment.associatedWorktreePath;
      if (input.environment.envMode !== "worktree" || !path) {
        return Effect.void;
      }
      const expectedBranch = makeAutomationBranchName(input.definition, input.run.id);
      // Only delete the branch minted for this not-yet-owned automation worktree.
      const branch =
        input.environment.associatedWorktreeBranch === expectedBranch ? expectedBranch : null;
      const removeWorktree = git
        .removeWorktree({
          cwd: input.project.workspaceRoot,
          path,
          force: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("automation unattached worktree cleanup failed", {
              automationId: input.definition.id,
              runId: input.run.id,
              path,
              reason: input.reason,
              error: errorMessage(error),
            }),
          ),
          Effect.asVoid,
        );
      const deleteBranch = branch
        ? git
            .deleteBranch({
              cwd: input.project.workspaceRoot,
              branch,
              force: true,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("automation unattached branch cleanup failed", {
                  automationId: input.definition.id,
                  runId: input.run.id,
                  branch,
                  reason: input.reason,
                  error: errorMessage(error),
                }),
              ),
              Effect.asVoid,
            )
        : Effect.void;

      return removeWorktree.pipe(Effect.flatMap(() => deleteBranch));
    };

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

    const validateSchedulePolicy = (input: {
      readonly schedule: AutomationDefinition["schedule"];
      readonly enabled: boolean;
      readonly maxIterations: AutomationDefinition["maxIterations"];
      readonly minimumIntervalSeconds: number;
      readonly acknowledgedRisks: readonly string[];
      readonly now: string;
    }) =>
      Effect.try({
        try: () => {
          const spacingSeconds = computeAutomationScheduleSpacingSeconds(input.schedule, input.now);
          if (
            spacingSeconds !== null &&
            spacingSeconds < DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS
          ) {
            if (!input.acknowledgedRisks.includes("fast-interval")) {
              throw new Error(
                `Automation schedule must run at least ${DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS} seconds apart.`,
              );
            }
            const exceedsFastIterationCap =
              input.maxIterations === null ||
              input.maxIterations > DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS;
            // Pausing a legacy fast loop must always remain possible; enforce the new
            // hard cap only for definitions that will continue running.
            if (input.enabled && exceedsFastIterationCap) {
              throw new Error(
                `Fast interval automations must set max iterations to ${DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS} runs or fewer.`,
              );
            }
          }
          const minimumIntervalSeconds = effectiveMinimumIntervalSeconds(input);
          if (spacingSeconds !== null && spacingSeconds < minimumIntervalSeconds) {
            throw new Error(
              `Automation schedule must run at least ${minimumIntervalSeconds} seconds apart.`,
            );
          }
          const nextRunAt = computeNextAutomationRunAt(input.schedule, input.now);
          if (input.enabled && input.schedule.type !== "manual" && nextRunAt === null) {
            throw new Error("Automation schedule must have a future run time.");
          }
        },
        catch: (cause) =>
          new AutomationServiceError({
            message: errorMessage(cause),
            cause,
          }),
      }).pipe(Effect.asVoid);

    const validateExecutionPolicies = (input: {
      readonly retryPolicy: AutomationDefinition["retryPolicy"];
    }) =>
      input.retryPolicy.type === "none"
        ? Effect.void
        : Effect.fail(
            new AutomationServiceError({
              message: "Automation retry policies are not supported yet.",
            }),
          );

    const validateRiskAcknowledgements = (input: {
      readonly runtimeMode: AutomationDefinition["runtimeMode"];
      readonly worktreeMode: AutomationDefinition["worktreeMode"];
      readonly acknowledgedRisks: readonly string[];
    }) => {
      const message = riskAcknowledgementError(input);
      return message
        ? Effect.fail(
            new AutomationServiceError({
              message,
            }),
          )
        : Effect.void;
    };

    const resolveThreadEnvironment = (
      definition: AutomationDefinition,
      project: OrchestrationProjectShell,
      runId: AutomationRunId,
      beforeWorktreeCreate: () => Effect.Effect<void, AutomationServiceError> = () => Effect.void,
    ): Effect.Effect<ThreadEnvironment, AutomationServiceError> => {
      const requireLocalCheckoutAcknowledgement = () =>
        definition.acknowledgedRisks.includes("local-checkout")
          ? Effect.void
          : Effect.fail(
              new AutomationServiceError({
                message: "Automation local checkout fallback requires an explicit acknowledgement.",
              }),
            );

      if (definition.worktreeMode === "local") {
        return requireLocalCheckoutAcknowledgement().pipe(Effect.as(localThreadEnvironment));
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
              : requireLocalCheckoutAcknowledgement().pipe(Effect.as(localThreadEnvironment));
          }

          const sourceBranch = status.branch;
          const branch = makeAutomationBranchName(definition, runId);
          return beforeWorktreeCreate().pipe(
            Effect.flatMap(() =>
              git
                .createWorktree({
                  cwd: project.workspaceRoot,
                  branch: sourceBranch,
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
                ),
            ),
          );
        }),
        Effect.catch((error) =>
          definition.worktreeMode === "auto"
            ? requireLocalCheckoutAcknowledgement().pipe(Effect.as(localThreadEnvironment))
            : Effect.fail(error),
        ),
      );
    };

    // Heartbeat runs reuse busy user threads, so reconcile only against the turn created
    // from this run's stored message id; the shell's latest turn may belong to someone else.
    const resolveRunTurn = (
      run: AutomationRun,
      shell: OrchestrationThreadShell,
    ): Effect.Effect<
      ProjectionTurn | OrchestrationThreadShell["latestTurn"] | null,
      AutomationServiceError
    > => {
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
      return Effect.gen(function* () {
        const plannedIds = deriveAutomationRunIds(run.id);
        const plannedThreadId =
          definition.mode === "heartbeat" ? run.threadId : plannedIds.threadId;
        const messageId = run.messageId;
        const turnStartCommandId = run.turnStartCommandId;
        if (!plannedThreadId || !messageId || !turnStartCommandId) {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Automation run is missing planned dispatch references.",
            }),
          );
        }

        const stopIfRunCannotDispatch = (latest: AutomationRun, detail: string) =>
          latest.status === "running"
            ? Effect.succeed(latest)
            : publish({ type: "run-upserted", run: latest }).pipe(
                Effect.flatMap(() =>
                  Effect.fail(
                    new AutomationServiceError({
                      message: detail,
                    }),
                  ),
                ),
              );

        const markRunDispatchStarted = (
          threadId: ThreadId,
          threadCreateCommandId: CommandId | null,
        ) =>
          automationRepository
            .markRunStarted({
              id: run.id,
              threadId,
              messageId,
              threadCreateCommandId,
              turnStartCommandId,
              startedAt: now,
            })
            .pipe(
              Effect.mapError(toServiceError("Failed to update automation run.")),
              Effect.tap((started) => publish({ type: "run-upserted", run: started })),
              Effect.flatMap((started) =>
                stopIfRunCannotDispatch(
                  started,
                  "Automation run was cancelled before dispatch started.",
                ),
              ),
            );

        const requireRunStillDispatching = (detail: string) =>
          automationRepository.getRunById({ id: run.id }).pipe(
            Effect.mapError(toServiceError("Failed to load automation run.")),
            Effect.flatMap((runOption) =>
              Option.match(runOption, {
                onNone: () =>
                  Effect.fail(
                    new AutomationServiceError({
                      message: "Automation run no longer exists.",
                    }),
                  ),
                onSome: (latest) => stopIfRunCannotDispatch(latest, detail),
              }),
            ),
          );

        if (definition.mode === "heartbeat") {
          const targetThreadId = definition.targetThreadId;
          if (!targetThreadId) {
            return yield* Effect.fail(
              new AutomationServiceError({
                message: "Heartbeat automation has no target thread to continue.",
              }),
            );
          }

          const started = yield* markRunDispatchStarted(targetThreadId, null);
          yield* requireRunStillDispatching(
            "Automation run was cancelled before continuing the thread.",
          );

          yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.start",
              commandId: turnStartCommandId,
              threadId: targetThreadId,
              message: {
                messageId,
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

          return { run: started };
        }

        const project = yield* requireProject(definition.projectId);
        const threadCreateCommandId = run.threadCreateCommandId;
        if (!threadCreateCommandId) {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Standalone automation run is missing its planned thread command.",
            }),
          );
        }
        const started = yield* markRunDispatchStarted(plannedThreadId, threadCreateCommandId);
        const environment = yield* resolveThreadEnvironment(definition, project, run.id, () =>
          requireRunStillDispatching(
            "Automation run was cancelled before creating the automation worktree.",
          ).pipe(Effect.asVoid),
        );
        yield* requireRunStillDispatching(
          "Automation run was cancelled before creating the automation thread.",
        ).pipe(
          Effect.catch((error) =>
            cleanupUnattachedWorktree({
              definition,
              run,
              project,
              environment,
              reason: "cancelled-before-thread-create",
            }).pipe(Effect.flatMap(() => Effect.fail(error))),
          ),
        );

        yield* orchestrationEngine
          .dispatch({
            type: "thread.create",
            commandId: threadCreateCommandId,
            threadId: plannedThreadId,
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
          .pipe(
            Effect.mapError(toServiceError("Failed to create automation thread.")),
            Effect.catch((error) =>
              cleanupUnattachedWorktree({
                definition,
                run,
                project,
                environment,
                reason: "thread-create-failed",
              }).pipe(Effect.flatMap(() => Effect.fail(error))),
            ),
          );

        yield* requireRunStillDispatching(
          "Automation run was cancelled before starting the automation turn.",
        );
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.start",
            commandId: turnStartCommandId,
            threadId: plannedThreadId,
            message: {
              messageId,
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

        return { run: started };
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const failedAt = isoNow();
            const summary = errorMessage(error);
            const failed = yield* automationRepository
              .markRunFailed({
                id: run.id,
                error: summary,
                finishedAt: failedAt,
              })
              .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
            if (failed.status !== "failed") {
              yield* publish({ type: "run-upserted", run: failed });
              return yield* Effect.fail(error);
            }
            const withResult = yield* automationRepository
              .markRunResult({
                id: failed.id,
                result: resultForRunStatus("failed", { summary, now: failedAt }),
                updatedAt: failedAt,
              })
              .pipe(Effect.mapError(toServiceError("Failed to update automation run result.")));
            yield* publish({ type: "run-upserted", run: withResult });
            yield* maybeStopLoop(withResult, "failed", failedAt);
            return yield* Effect.fail(error);
          }).pipe(Effect.catch(() => Effect.fail(error))),
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
      options: { readonly threadIdOverride?: ThreadId | null } = {},
    ) =>
      Effect.gen(function* () {
        const runId = makeAutomationRunId();
        const ids = deriveAutomationRunIds(runId);
        const threadId =
          "threadIdOverride" in options
            ? options.threadIdOverride
            : definition.mode === "heartbeat"
              ? definition.targetThreadId
              : ids.threadId;
        const run = yield* automationRepository
          .createRun({
            id: runId,
            automationId: definition.id,
            projectId: definition.projectId,
            threadId,
            messageId: ids.messageId,
            threadCreateCommandId:
              definition.mode === "heartbeat" ? null : ids.threadCreateCommandId,
            turnStartCommandId: ids.turnStartCommandId,
            trigger,
            scheduledFor,
            permissionSnapshot: makePermissionSnapshot(definition, now),
            now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to create automation run.")));
        yield* publish({ type: "run-upserted", run });
        return { run, inserted: run.id === runId };
      });

    // Recovery may find a durable run + thread without the queued turn row; retire it so
    // future heartbeat ticks and scheduled occurrences are not blocked forever.
    const interruptRunForRecovery = (run: AutomationRun, now: string) =>
      automationRepository.markRunInterrupted({ id: run.id, turnId: null, finishedAt: now }).pipe(
        Effect.flatMap((interrupted) =>
          interrupted.status !== "interrupted"
            ? Effect.succeed(interrupted)
            : automationRepository
                .markRunResult({
                  id: interrupted.id,
                  result: resultForRunStatus("interrupted", {
                    summary: "Automation run was interrupted during recovery.",
                    now,
                  }),
                  updatedAt: now,
                })
                .pipe(Effect.orElseSucceed(() => interrupted)),
        ),
        Effect.tap((updated) => publish({ type: "run-upserted", run: updated })),
      );

    // Stop checks must only evaluate evidence from the just-finished heartbeat turn.
    const findRunCompletionMessages = (input: {
      readonly run: AutomationRun;
      readonly thread: {
        readonly messages: ReadonlyArray<{
          readonly id: string;
          readonly role: string;
          readonly text: string;
          readonly turnId: string | null;
        }>;
      };
    }) => {
      const runMessages = input.thread.messages.filter(
        (message) =>
          message.id === input.run.messageId ||
          (input.run.turnId !== null && message.turnId === input.run.turnId),
      );
      const userMessage =
        input.thread.messages.find((message) => message.id === input.run.messageId)?.text ?? "";
      const assistantMessages = runMessages.filter((message) => message.role === "assistant");
      const runThreadContext = runMessages
        .slice(-8)
        .map((message) => `${message.role}: ${message.text}`)
        .join("\n\n");
      return {
        runUserMessage: userMessage,
        runAssistantText:
          assistantMessages.length > 0
            ? assistantMessages.map((message) => message.text).join("\n\n")
            : "",
        runThreadContext,
      };
    };

    const staleStopCheckEvaluation = (rawEvaluation: AutomationCompletionEvaluation) => ({
      ...rawEvaluation,
      stopMatched: false,
      reason: normalizeAutomationCompletionReason(
        "Stop check ignored because the automation changed before evaluation finished.",
      ),
    });

    const disableDefinitionForCompletionMatch = (definition: AutomationDefinition) =>
      automationRepository
        .disableDefinitionIfUnchanged({
          id: definition.id,
          expectedUpdatedAt: definition.updatedAt,
          now: isoNow(),
        })
        .pipe(Effect.mapError(toServiceError("Failed to disable automation.")));

    // The AI check runs after the run is published; reload so read/archive changes win the race.
    const latestRunForCompletionResult = (run: AutomationRun) =>
      automationRepository.getRunById({ id: run.id }).pipe(
        Effect.mapError(toServiceError("Failed to load automation run.")),
        Effect.map((runOption) =>
          Option.match(runOption, {
            onNone: () => run,
            onSome: (latestRun) => latestRun,
          }),
        ),
      );

    const recordCompletionEvaluation = (input: {
      readonly run: AutomationRun;
      readonly evaluation: AutomationCompletionEvaluation;
      readonly matched: boolean;
      readonly summary?: string;
      readonly severity?: NonNullable<AutomationRunResult["severity"]>;
    }) =>
      Effect.gen(function* () {
        const latestRun = yield* latestRunForCompletionResult(input.run);
        const updatedAt = isoNow();
        const updated = yield* automationRepository
          .markRunResult({
            id: latestRun.id,
            result: automationCompletionRunResult({
              baseResult: latestRun.result,
              evaluation: input.evaluation,
              matched: input.matched,
              ...(input.summary !== undefined ? { summary: input.summary } : {}),
              ...(input.severity ? { severity: input.severity } : {}),
            }),
            updatedAt,
          })
          .pipe(Effect.mapError(toServiceError("Failed to update automation run result.")));
        yield* publish({ type: "run-upserted", run: updated });
        return updated;
      });

    const resolveAutomationCompletionTextGenerationInput = (definition: AutomationDefinition) =>
      Effect.gen(function* () {
        const directInput = resolveTextGenerationInputForSelection(
          definition.modelSelection,
          definition.providerOptions,
        );
        if (directInput) {
          return directInput;
        }

        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(toServiceError("Failed to load text-generation settings.")),
        );
        return (
          resolveTextGenerationInputForSelection(
            settings.textGenerationModelSelection,
            definition.providerOptions,
          ) ?? {}
        );
      });

    const shouldUseStopPolicyForDefinition = (
      definition: AutomationDefinition,
      policy: Extract<AutomationCompletionPolicy, { type: "ai-evaluated" }>,
    ): boolean => {
      const currentPolicy = completionPolicyForDefinition(definition);
      return (
        definition.mode === "heartbeat" &&
        definition.enabled &&
        definition.archivedAt === null &&
        currentPolicy.type === "ai-evaluated" &&
        isSameAiCompletionPolicy(currentPolicy, policy)
      );
    };

    const loadCurrentStopDefinition = (
      definition: AutomationDefinition,
      policy: Extract<AutomationCompletionPolicy, { type: "ai-evaluated" }>,
    ) =>
      automationRepository.getDefinitionById({ id: definition.id }).pipe(
        Effect.mapError(toServiceError("Failed to load automation.")),
        Effect.map((definitionOption) =>
          Option.match(definitionOption, {
            onNone: () => Option.none<AutomationDefinition>(),
            onSome: (currentDefinition) =>
              currentDefinition.updatedAt === definition.updatedAt &&
              shouldUseStopPolicyForDefinition(currentDefinition, policy)
                ? Option.some(currentDefinition)
                : Option.none<AutomationDefinition>(),
          }),
        ),
      );

    const evaluateCompletionPolicy = (
      definition: AutomationDefinition,
      run: AutomationRun,
      policy: Extract<AutomationCompletionPolicy, { type: "ai-evaluated" }>,
    ) =>
      Effect.gen(function* () {
        if (!run.threadId) {
          yield* recordCompletionEvaluation({
            run,
            evaluation: failedAutomationCompletionEvaluation(
              "Stop check skipped because the automation run has no target thread.",
            ),
            matched: false,
            summary: "Stop check skipped because the automation run has no target thread.",
            severity: "warning",
          });
          return false;
        }
        const project = yield* requireProject(definition.projectId);
        const threadOption = yield* projectionSnapshotQuery
          .getThreadDetailById(run.threadId)
          .pipe(Effect.mapError(toServiceError("Failed to load automation thread detail.")));
        if (Option.isNone(threadOption)) {
          yield* recordCompletionEvaluation({
            run,
            evaluation: failedAutomationCompletionEvaluation(
              "Stop check skipped because the target thread could not be found.",
            ),
            matched: false,
            summary: "Stop check skipped because the target thread could not be found.",
            severity: "warning",
          });
          return false;
        }
        const thread = threadOption.value;
        const { runUserMessage, runAssistantText, runThreadContext } = findRunCompletionMessages({
          run,
          thread,
        });
        const textGenerationInput =
          yield* resolveAutomationCompletionTextGenerationInput(definition);
        const evaluationRaw = yield* textGeneration
          .evaluateAutomationCompletion({
            cwd: project.workspaceRoot,
            automationName: definition.name,
            automationPrompt: definition.prompt,
            stopWhen: policy.stopWhen,
            runUserMessage: runUserMessage || definition.prompt,
            runAssistantText: runAssistantText || "(no assistant output)",
            threadContext: runThreadContext || "(no run-scoped thread context)",
            ...textGenerationInput,
          })
          .pipe(Effect.mapError(toServiceError("Failed to evaluate automation stop condition.")));
        const rawEvaluation = {
          stopMatched: evaluationRaw.stopMatched,
          confidence: Math.max(0, Math.min(1, evaluationRaw.confidence)),
          reason: normalizeAutomationCompletionReason(evaluationRaw.reason),
        };
        const currentDefinitionOption = yield* loadCurrentStopDefinition(definition, policy);
        const policyStillCurrent = Option.isSome(currentDefinitionOption);
        const evaluation: AutomationCompletionEvaluation = policyStillCurrent
          ? rawEvaluation
          : staleStopCheckEvaluation(rawEvaluation);
        const matched =
          policyStillCurrent &&
          evaluation.stopMatched &&
          evaluation.confidence >= policy.confidenceThreshold;
        if (!matched) {
          yield* recordCompletionEvaluation({
            run,
            evaluation,
            matched: false,
          });
          return false;
        }
        const currentDefinition = Option.getOrThrow(currentDefinitionOption);
        // Disable before clearing the pending stop-check marker, so no extra heartbeat can launch.
        const disabled = yield* disableDefinitionForCompletionMatch(currentDefinition);
        if (!disabled) {
          yield* recordCompletionEvaluation({
            run,
            evaluation: staleStopCheckEvaluation(rawEvaluation),
            matched: false,
          });
          return false;
        }
        yield* publishDefinition(currentDefinition.id);
        yield* recordCompletionEvaluation({
          run,
          evaluation,
          matched: true,
        });
        return true;
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const reason = completionFailureReason(error);
            yield* Effect.logWarning("automation completion evaluation failed", {
              automationId: definition.id,
              runId: run.id,
              error: errorMessage(error),
            });
            // Keep the heartbeat active, but make the failed stop check visible in run history.
            yield* recordCompletionEvaluation({
              run,
              evaluation: failedAutomationCompletionEvaluation(reason),
              matched: false,
              summary: reason,
              severity: "warning",
            }).pipe(
              Effect.catch((recordError) =>
                Effect.logWarning(
                  "automation completion evaluation failure could not be recorded",
                  {
                    automationId: definition.id,
                    runId: run.id,
                    error: errorMessage(recordError),
                  },
                ),
              ),
            );
            return false;
          }),
        ),
      );

    const enqueueCompletionEvaluationJob = (job: AutomationCompletionEvaluationJob) =>
      Effect.sync(() => {
        if (queuedCompletionEvaluationRunIds.has(job.run.id)) {
          return "duplicate" as const;
        }
        if (
          queuedCompletionEvaluationRunIds.size >= AUTOMATION_COMPLETION_EVALUATION_QUEUE_CAPACITY
        ) {
          return "full" as const;
        }
        queuedCompletionEvaluationRunIds.add(job.run.id);
        return "queued" as const;
      }).pipe(
        Effect.flatMap((state) => {
          switch (state) {
            case "duplicate":
              return Effect.void;
            case "full":
              return Effect.logWarning("automation completion evaluation queue at capacity", {
                automationId: job.definition.id,
                runId: job.run.id,
                capacity: AUTOMATION_COMPLETION_EVALUATION_QUEUE_CAPACITY,
              });
            case "queued":
              return Queue.offer(completionEvaluationQueue, job).pipe(Effect.asVoid);
          }
        }),
      );

    const enqueueCompletionEvaluationForRun = (run: AutomationRun) => {
      if (run.status !== "succeeded" || run.result?.completionEvaluation !== undefined) {
        return Effect.void;
      }

      return automationRepository.getDefinitionById({ id: run.automationId }).pipe(
        Effect.mapError(toServiceError("Failed to load automation.")),
        Effect.flatMap((definitionOption) =>
          Option.match(definitionOption, {
            onNone: () => Effect.void,
            onSome: (definition) => {
              const policy = completionPolicyForDefinition(definition);
              if (policy.type !== "ai-evaluated") {
                return Effect.void;
              }
              if (!shouldUseStopPolicyForDefinition(definition, policy)) {
                return Effect.void;
              }
              if (!runUsesCurrentCompletionPolicy(run, definition)) {
                return Effect.void;
              }
              return enqueueCompletionEvaluationJob({
                definition,
                run,
                policy,
              });
            },
          }),
        ),
      );
    };

    const enqueuePendingCompletionEvaluations = () =>
      automationRepository.listRunsNeedingCompletionEvaluation({ limit: 100 }).pipe(
        Effect.mapError(toServiceError("Failed to list pending stop evaluations.")),
        Effect.flatMap((runs) =>
          Effect.forEach(runs, enqueueCompletionEvaluationForRun, { concurrency: 1 }),
        ),
        Effect.asVoid,
      );

    const processCompletionEvaluationJob = (job: AutomationCompletionEvaluationJob) =>
      evaluateCompletionPolicy(job.definition, job.run, job.policy).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("automation completion evaluation worker failed", {
            automationId: job.definition.id,
            runId: job.run.id,
            cause: Cause.pretty(cause),
          });
        }),
        Effect.ensuring(Effect.sync(() => queuedCompletionEvaluationRunIds.delete(job.run.id))),
      );

    const completionEvaluationWorker = Effect.forever(
      Queue.take(completionEvaluationQueue).pipe(
        Effect.flatMap(processCompletionEvaluationJob),
        Effect.flatMap(() =>
          enqueuePendingCompletionEvaluations().pipe(
            Effect.catch((error) =>
              Effect.logWarning("automation pending stop evaluations could not be requeued", {
                error: errorMessage(error),
              }),
            ),
          ),
        ),
      ),
    );

    yield* Effect.forEach(
      Array.from({ length: AUTOMATION_COMPLETION_EVALUATION_WORKERS }),
      () => Effect.forkScoped(completionEvaluationWorker),
      { discard: true },
    );

    yield* enqueuePendingCompletionEvaluations().pipe(
      Effect.catch((error) =>
        Effect.logWarning("automation pending stop evaluations could not be queued", {
          error: errorMessage(error),
        }),
      ),
    );

    const maybeStopLoop = (run: AutomationRun, status: AutomationRunStatus, now: string) =>
      automationRepository.getDefinitionById({ id: run.automationId }).pipe(
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
              const completionPolicy = completionPolicyForDefinition(definition);
              const enqueueAiStop =
                !reachedMax &&
                status === "succeeded" &&
                definition.mode === "heartbeat" &&
                completionPolicy.type === "ai-evaluated" &&
                runUsesCurrentCompletionPolicy(run, definition)
                  ? enqueueCompletionEvaluationJob({
                      definition,
                      run,
                      policy: completionPolicy,
                    })
                  : Effect.void;
              return enqueueAiStop.pipe(
                Effect.flatMap(() => {
                  if (!stopOnError && !reachedMax) {
                    return Effect.void;
                  }
                  return automationRepository.disableDefinition({ id: run.automationId, now }).pipe(
                    Effect.mapError(toServiceError("Failed to disable automation.")),
                    Effect.flatMap(() => publishDefinition(run.automationId)),
                  );
                }),
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
            const withResult = yield* automationRepository
              .markRunResult({
                id: updated.id,
                result: resultForRunStatus("waiting-for-approval", {
                  summary: "Automation run is waiting for input or approval.",
                  now,
                }),
                updatedAt: now,
              })
              .pipe(Effect.mapError(toServiceError("Failed to update automation run result.")));
            yield* publish({ type: "run-upserted", run: withResult });
          }
          return;
        }

        if (!turn || turn.turnId === null || turn.state === "pending" || turn.state === "running") {
          if (
            run.status === "waiting-for-approval" &&
            run.threadId &&
            run.messageId &&
            run.turnStartCommandId
          ) {
            const running = yield* automationRepository
              .markRunStarted({
                id: run.id,
                threadId: run.threadId,
                messageId: run.messageId,
                threadCreateCommandId: run.threadCreateCommandId,
                turnStartCommandId: run.turnStartCommandId,
                startedAt: run.startedAt ?? now,
              })
              .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
            const cleared = yield* automationRepository
              .markRunResult({
                id: running.id,
                result: null,
                updatedAt: now,
              })
              .pipe(Effect.mapError(toServiceError("Failed to update automation run result.")));
            yield* publish({ type: "run-upserted", run: cleared });
          }
          return;
        }

        let updated: AutomationRun;
        if (turn.state === "completed") {
          updated = yield* automationRepository
            .markRunSucceeded({
              id: run.id,
              turnId: turn.turnId,
              result: resultForRunStatus("succeeded", { now }),
              finishedAt: turn.completedAt ?? now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
        } else if (turn.state === "error") {
          const summary = errorMessage(shell.session?.lastError ?? "Automation turn failed.");
          updated = yield* automationRepository
            .markRunFailed({
              id: run.id,
              error: summary,
              finishedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
          updated = yield* automationRepository
            .markRunResult({
              id: updated.id,
              result: resultForRunStatus("failed", { summary, now }),
              updatedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to update automation run result.")));
        } else {
          updated = yield* automationRepository
            .markRunInterrupted({
              id: run.id,
              turnId: turn.turnId,
              finishedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
          updated = yield* automationRepository
            .markRunResult({
              id: updated.id,
              result: resultForRunStatus("interrupted", {
                summary: "Automation run was interrupted.",
                now,
              }),
              updatedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to update automation run result.")));
        }

        yield* publish({ type: "run-upserted", run: updated });
        yield* maybeStopLoop(updated, updated.status, now);
      });

    const failRunForTimeout = (definition: AutomationDefinition, run: AutomationRun, now: string) =>
      Effect.gen(function* () {
        const summary = `Automation run exceeded its ${definition.maxRuntimeSeconds}-second runtime limit.`;
        yield* interruptRunBestEffort(run, now);
        const failed = yield* automationRepository
          .markRunFailed({ id: run.id, error: summary, finishedAt: now })
          .pipe(Effect.mapError(toServiceError("Failed to time out automation run.")));
        if (failed.status !== "failed") {
          yield* publish({ type: "run-upserted", run: failed });
          return;
        }
        const withResult = yield* automationRepository
          .markRunResult({
            id: failed.id,
            result: resultForRunStatus("failed", { summary, now }),
            updatedAt: now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to update automation run result.")));
        yield* publish({ type: "run-upserted", run: withResult });
        yield* maybeStopLoop(withResult, "failed", now);
      });

    const reconcileActiveRun = (run: AutomationRun, now: string) =>
      automationRepository.getDefinitionById({ id: run.automationId }).pipe(
        Effect.mapError(toServiceError("Failed to load automation.")),
        Effect.flatMap((definitionOption) =>
          Option.match(definitionOption, {
            onNone: () => Effect.void,
            onSome: (definition) =>
              hasExceededMaxRuntime(definition, run, now)
                ? failRunForTimeout(definition, run, now)
                : run.threadId
                  ? reconcileThread({ threadId: run.threadId })
                  : Effect.void,
          }),
        ),
      );

    const reconcileActiveRuns: AutomationServiceShape["reconcileActiveRuns"] = () =>
      automationRepository.listRecoverableRuns({ limit: 100 }).pipe(
        Effect.mapError(toServiceError("Failed to list active automation runs.")),
        Effect.flatMap((runs) =>
          Effect.forEach(
            runs,
            (run) => reconcileActiveRun(run, isoNow()).pipe(Effect.catch(() => Effect.void)),
            { concurrency: 1 },
          ),
        ),
        Effect.flatMap(() => enqueuePendingCompletionEvaluations()),
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
                return interruptRunForRecovery(run, now).pipe(
                  Effect.mapError(toServiceError("Failed to recover automation run.")),
                  Effect.asVoid,
                  Effect.catch(() => Effect.void),
                );
              }
              return projectionSnapshotQuery.getThreadShellById(threadId).pipe(
                Effect.mapError(toServiceError("Failed to load automation thread state.")),
                Effect.flatMap((shellOption) =>
                  Option.isNone(shellOption)
                    ? interruptRunForRecovery(run, now).pipe(
                        Effect.mapError(toServiceError("Failed to recover automation run.")),
                        Effect.asVoid,
                      )
                    : resolveRunTurn(run, shellOption.value).pipe(
                        Effect.flatMap((turn) =>
                          turn === null
                            ? interruptRunForRecovery(run, now).pipe(
                                Effect.mapError(
                                  toServiceError("Failed to recover automation run."),
                                ),
                                Effect.asVoid,
                              )
                            : reconcileThread({ threadId }),
                        ),
                      ),
                ),
                Effect.catch(() => Effect.void),
              );
            },
            { concurrency: 1 },
          ),
        ),
        Effect.flatMap(() => enqueuePendingCompletionEvaluations()),
        Effect.asVoid,
      );

    const list: AutomationServiceShape["list"] = (input = {}) =>
      automationRepository
        .list(input)
        .pipe(Effect.mapError(toServiceError("Failed to list automations.")));

    const create: AutomationServiceShape["create"] = (input) =>
      Effect.gen(function* () {
        const now = isoNow();
        yield* requireProject(input.projectId);
        yield* validateSchedulePolicy({
          schedule: input.schedule,
          enabled: input.enabled ?? true,
          maxIterations: input.maxIterations ?? null,
          minimumIntervalSeconds:
            input.minimumIntervalSeconds ?? DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS,
          acknowledgedRisks: input.acknowledgedRisks ?? [],
          now,
        });
        yield* validateExecutionPolicies({
          retryPolicy: input.retryPolicy ?? { type: "none" },
        });
        yield* validateRiskAcknowledgements({
          runtimeMode: input.runtimeMode ?? "approval-required",
          worktreeMode: input.worktreeMode ?? "auto",
          acknowledgedRisks: input.acknowledgedRisks ?? [],
        });
        yield* validateHeartbeatTarget({
          mode: input.mode ?? "standalone",
          projectId: input.projectId,
          targetThreadId: input.targetThreadId ?? null,
        });
        const initialNextRunAt = computeNextAutomationRunAt(input.schedule, now);
        const definition = yield* automationRepository
          .createDefinition({ id: makeAutomationId(), input, now, nextRunAt: initialNextRunAt })
          .pipe(Effect.mapError(toServiceError("Failed to create automation.")));
        const normalized = yield* normalizeCreatedDefinitionSchedule(definition, now).pipe(
          Effect.mapError(toServiceError("Failed to initialize automation schedule.")),
        );
        yield* publish({ type: "definition-upserted", definition: normalized });
        return normalized;
      });

    const update: AutomationServiceShape["update"] = (input) =>
      Effect.gen(function* () {
        const now = isoNow();
        const current = yield* requireDefinition(input.id);
        const updated = mergeDefinitionUpdate(current, input, now);
        yield* requireProject(updated.projectId);
        yield* validateSchedulePolicy({
          schedule: updated.schedule,
          enabled: updated.enabled,
          maxIterations: updated.maxIterations,
          minimumIntervalSeconds: updated.minimumIntervalSeconds,
          acknowledgedRisks: updated.acknowledgedRisks,
          now,
        });
        yield* validateExecutionPolicies({ retryPolicy: updated.retryPolicy });
        yield* validateRiskAcknowledgements({
          runtimeMode: updated.runtimeMode,
          worktreeMode: updated.worktreeMode,
          acknowledgedRisks: updated.acknowledgedRisks,
        });
        yield* validateHeartbeatTarget(updated);
        const saved = yield* automationRepository
          .saveDefinition(updated)
          .pipe(Effect.mapError(toServiceError("Failed to update automation.")));
        yield* publish({ type: "definition-upserted", definition: saved });
        return saved;
      });

    const interruptRunBestEffort = (run: AutomationRun, now: string) => {
      if (!run.threadId) {
        return Effect.void;
      }
      return orchestrationEngine
        .dispatch({
          type: "thread.turn.interrupt",
          commandId: makeAutomationCommandId(run.id, "interrupt"),
          threadId: run.threadId,
          ...(run.turnId ? { turnId: run.turnId } : {}),
          createdAt: now,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("automation run interrupt failed", {
              runId: run.id,
              threadId: run.threadId,
              error: errorMessage(error),
            }),
          ),
          Effect.asVoid,
        );
    };

    const cancelRunById = (input: { readonly runId: AutomationRunId }) =>
      Effect.gen(function* () {
        const now = isoNow();
        const run = yield* automationRepository
          .cancelRun({ ...input, now })
          .pipe(Effect.mapError(toServiceError("Failed to cancel automation run.")));
        if (run.status !== "cancelled") {
          yield* publish({ type: "run-upserted", run });
          return run;
        }
        const withResult = yield* automationRepository
          .markRunResult({
            id: run.id,
            result: resultForRunStatus("cancelled", {
              summary: "Automation run was cancelled.",
              now,
            }),
            updatedAt: now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to update automation run result.")));
        yield* interruptRunBestEffort(withResult, now);
        yield* publish({ type: "run-upserted", run: withResult });
        return withResult;
      });

    const deleteAutomation: AutomationServiceShape["delete"] = (input) =>
      Effect.gen(function* () {
        const activeRuns = yield* automationRepository
          .listActiveRunsForDefinition({ automationId: input.id })
          .pipe(Effect.mapError(toServiceError("Failed to load active automation runs.")));
        yield* Effect.forEach(
          activeRuns,
          (run) => cancelRunById({ runId: run.id }).pipe(Effect.catch(() => Effect.void)),
          { concurrency: 1 },
        );
        yield* automationRepository
          .archiveDefinition({ id: input.id, archivedAt: isoNow() })
          .pipe(Effect.mapError(toServiceError("Failed to delete automation.")));
        yield* publish({ type: "definition-deleted", automationId: input.id });
      });

    const heartbeatThreadRunState = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const activeRuns = yield* automationRepository
          .countActiveRunsForThread({ threadId })
          .pipe(Effect.mapError(toServiceError("Failed to count active automation runs.")));
        const pendingCompletionEvaluations = yield* automationRepository
          .countPendingCompletionEvaluationsForThread({ threadId })
          .pipe(
            Effect.mapError(toServiceError("Failed to count pending automation stop evaluations.")),
          );
        return { activeRuns, pendingCompletionEvaluations };
      });

    const restartExhaustedBoundedDefinition = (definition: AutomationDefinition, now: string) =>
      Effect.gen(function* () {
        if (
          definition.maxIterations === null ||
          definition.iterationCount < definition.maxIterations
        ) {
          return definition;
        }
        const computedNextRunAt =
          definition.schedule.type === "manual"
            ? null
            : computeNextAutomationRunAtAfter(definition.schedule, now, now);
        // Manual reruns should not revive legacy definitions that cannot pass today's
        // active-schedule policy, such as oversized sub-minute loops.
        let canBecomeEnabled = false;
        if (definition.schedule.type === "manual" || computedNextRunAt !== null) {
          canBecomeEnabled = yield* validateSchedulePolicy({
            schedule: definition.schedule,
            enabled: true,
            maxIterations: definition.maxIterations,
            minimumIntervalSeconds: definition.minimumIntervalSeconds,
            acknowledgedRisks: definition.acknowledgedRisks,
            now,
          }).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
        }
        const enabled = canBecomeEnabled;
        const nextRunAt = enabled ? computedNextRunAt : null;
        const restarted = {
          ...definition,
          enabled,
          iterationCount: 0,
          nextRunAt,
          updatedAt: now,
        };
        return yield* automationRepository
          .restartDefinitionLoop({ id: definition.id, enabled, nextRunAt, updatedAt: now })
          .pipe(
            Effect.mapError(toServiceError("Failed to restart automation loop.")),
            Effect.as(restarted),
            Effect.tap((definition) => publish({ type: "definition-upserted", definition })),
          );
      });

    const runNow: AutomationServiceShape["runNow"] = (input) =>
      Effect.gen(function* () {
        const definition = yield* requireDefinition(input.automationId);
        const now = isoNow();
        // Heartbeat automations continue a single shared thread, so a manual run must not
        // race a scheduled (or earlier manual) run that is still in flight. Standalone
        // automations spawn independent threads, so concurrent manual runs are fine.
        if (definition.mode === "heartbeat") {
          if (!definition.targetThreadId) {
            return yield* Effect.fail(
              new AutomationServiceError({
                message: "Heartbeat automation has no target thread to continue.",
              }),
            );
          }
          const runState = yield* heartbeatThreadRunState(definition.targetThreadId);
          if (runState.activeRuns > 0) {
            return yield* Effect.fail(
              new AutomationServiceError({
                message: "This thread already has a run in progress.",
              }),
            );
          }
          if (runState.pendingCompletionEvaluations > 0) {
            return yield* Effect.fail(
              new AutomationServiceError({
                message: "This thread already has a stop check in progress.",
              }),
            );
          }
        }
        const runnableDefinition = yield* restartExhaustedBoundedDefinition(definition, now);
        const { run, inserted } = yield* createPendingRun(
          runnableDefinition,
          { type: "manual" },
          now,
          now,
        );
        if (!inserted) {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "This thread already has a run in progress.",
            }),
          );
        }
        yield* automationRepository
          .incrementDefinitionIterationCount({ id: runnableDefinition.id, now })
          .pipe(Effect.mapError(toServiceError("Failed to update automation iteration count.")));
        return yield* dispatchRun(runnableDefinition, run, now);
      });

    const cancelRun: AutomationServiceShape["cancelRun"] = (input) =>
      cancelRunById(input).pipe(Effect.map((run) => ({ run })));

    const markRunRead: AutomationServiceShape["markRunRead"] = (input) =>
      automationRepository.markRunRead({ ...input, now: isoNow() }).pipe(
        Effect.mapError(toServiceError("Failed to update automation run.")),
        Effect.tap((run) => publish({ type: "run-upserted", run })),
        Effect.map((run) => ({ run })),
      );

    const archiveRun: AutomationServiceShape["archiveRun"] = (input) =>
      automationRepository.archiveRun({ ...input, now: isoNow() }).pipe(
        Effect.mapError(toServiceError("Failed to update automation run.")),
        Effect.tap((run) => publish({ type: "run-upserted", run })),
        Effect.map((run) => ({ run })),
      );

    const markScheduledRunSkipped = (run: AutomationRun, reason: string, now: string) =>
      Effect.gen(function* () {
        const skipped = yield* automationRepository
          .markRunSkipped({ id: run.id, reason, finishedAt: now })
          .pipe(Effect.mapError(toServiceError("Failed to skip automation run.")));
        const withResult = yield* automationRepository
          .markRunResult({
            id: skipped.id,
            result: resultForRunStatus("skipped", { summary: reason, now }),
            updatedAt: now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to update automation run result.")));
        yield* publish({ type: "run-upserted", run: withResult });
        return withResult;
      });

    const advanceScheduledDefinition = (
      definition: AutomationDefinition,
      nextRunAt: string | null,
      now: string,
    ) =>
      Effect.gen(function* () {
        if (definition.schedule.type === "once" && nextRunAt === null) {
          yield* automationRepository
            .disableDefinition({ id: definition.id, now })
            .pipe(Effect.mapError(toServiceError("Failed to complete one-shot automation.")));
        } else {
          yield* automationRepository
            .setDefinitionNextRunAt({ id: definition.id, nextRunAt, updatedAt: now })
            .pipe(Effect.mapError(toServiceError("Failed to advance automation schedule.")));
        }
        yield* publishDefinition(definition.id);
      });

    // Run one due definition: enforce the iteration cap, apply misfire policy, skip when a
    // prior heartbeat run is still in flight, then dispatch. The run row is durable before
    // schedule advancement, so dispatch failures still leave auditable history.
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

        const occurrence = scheduledOccurrenceForDefinition(definition, now);
        const { scheduledFor, nextRunAt } = occurrence;
        if (occurrence.skip) {
          const { run, inserted } = yield* createPendingRun(
            definition,
            { type: "scheduled" },
            scheduledFor,
            now,
            { threadIdOverride: null },
          );
          if (inserted) {
            yield* markScheduledRunSkipped(run, "Scheduled occurrence was missed.", now);
          }
          yield* advanceScheduledDefinition(definition, nextRunAt, now);
          return Option.none<AutomationRunNowResult>();
        }

        if (definition.mode === "heartbeat") {
          const targetThreadId = definition.targetThreadId;
          if (!targetThreadId) {
            return yield* Effect.fail(
              new AutomationServiceError({
                message: "Heartbeat automation has no target thread to continue.",
              }),
            );
          }
          const runState = yield* heartbeatThreadRunState(targetThreadId);
          if (runState.pendingCompletionEvaluations > 0) {
            return Option.none<AutomationRunNowResult>();
          }
          if (runState.activeRuns > 0) {
            const reason = "Target thread already has an automation run in progress.";
            const { run, inserted } = yield* createPendingRun(
              definition,
              { type: "scheduled" },
              scheduledFor,
              now,
              { threadIdOverride: null },
            );
            if (inserted) {
              yield* markScheduledRunSkipped(run, reason, now);
            }
            yield* advanceScheduledDefinition(definition, nextRunAt, now);
            return Option.none<AutomationRunNowResult>();
          }
        }

        const { run, inserted } = yield* createPendingRun(
          definition,
          { type: "scheduled" },
          scheduledFor,
          now,
        );
        // The run is now durable, so it is safe to advance the schedule even if dispatch fails.
        yield* advanceScheduledDefinition(definition, nextRunAt, now);

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
      markRunRead,
      archiveRun,
      runDueOnce,
      reconcileThread,
      reconcileActiveRuns,
      recoverPendingRuns,
      streamEvents: Stream.fromPubSub(events),
    } satisfies AutomationServiceShape;
  }),
);
