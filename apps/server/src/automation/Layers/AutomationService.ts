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
  type AutomationStreamEvent,
  type AutomationUpdateInput,
  type OrchestrationProjectShell,
  type ThreadEnvironmentMode,
} from "@t3tools/contracts";
import { Effect, Layer, Option, PubSub, Stream } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import { AutomationServiceError } from "../Errors.ts";
import {
  AutomationService,
  type AutomationServiceShape,
} from "../Services/AutomationService.ts";
import { computeNextAutomationRunAt } from "../schedule.ts";

const AUTOMATION_ERROR_MAX_CHARS = 4_000;

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

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.slice(0, AUTOMATION_ERROR_MAX_CHARS);
  }
  const message = String(cause);
  return message.slice(0, AUTOMATION_ERROR_MAX_CHARS);
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
        : current.nextRunAt ?? computeNextAutomationRunAt(schedule, now);
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
  const suffix = runId.replace(/[^a-z0-9]+/gi, "-").slice(-12).toLowerCase();
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

export const AutomationServiceLive = Layer.effect(
  AutomationService,
  Effect.gen(function* () {
    const automationRepository = yield* AutomationRepository;
    const git = yield* GitCore;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const events = yield* PubSub.sliding<AutomationStreamEvent>(256);

    const publish = (event: AutomationStreamEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

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

    const requireProject = (projectId: AutomationDefinition["projectId"]) =>
      projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.mapError(toServiceError("Failed to load project snapshot.")),
        Effect.flatMap((snapshot) => {
          const project = snapshot.projects.find((entry) => entry.id === projectId);
          return project
            ? Effect.succeed(project)
            : Effect.fail(new AutomationServiceError({ message: "Automation project was not found." }));
        }),
      );

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
                    message: "Automation requires a Git worktree, but the project is not on a branch.",
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

    const dispatchRun = (
      definition: AutomationDefinition,
      run: AutomationRun,
      project: OrchestrationProjectShell,
      now: string,
    ): Effect.Effect<AutomationRunNowResult, AutomationServiceError> => {
      const ids = deriveAutomationRunIds(run.id);
      return Effect.gen(function* () {
        const environment = yield* resolveThreadEnvironment(definition, project, run.id);

        yield* orchestrationEngine.dispatch({
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
        }).pipe(Effect.mapError(toServiceError("Failed to create automation thread.")));

        yield* orchestrationEngine.dispatch({
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
        }).pipe(Effect.mapError(toServiceError("Failed to start automation turn.")));

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
              finishedAt: new Date().toISOString(),
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

    const createRunForDefinition = (
      definition: AutomationDefinition,
      trigger: AutomationRun["trigger"],
      scheduledFor: string,
      now: string,
    ) =>
      Effect.gen(function* () {
        const run = yield* automationRepository
          .createRun({
            id: makeAutomationRunId(),
            automationId: definition.id,
            projectId: definition.projectId,
            threadId: null,
            trigger,
            scheduledFor,
            permissionSnapshot: makePermissionSnapshot(definition, now),
            now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to create automation run.")));
        yield* publish({ type: "run-upserted", run });
        const project = yield* requireProject(definition.projectId);
        return yield* dispatchRun(definition, run, project, now);
      });

    const list: AutomationServiceShape["list"] = (input = {}) =>
      automationRepository
        .list(input)
        .pipe(Effect.mapError(toServiceError("Failed to list automations.")));

    const create: AutomationServiceShape["create"] = (input) => {
      const now = new Date().toISOString();
      return automationRepository
        .createDefinition({ id: makeAutomationId(), input, now })
        .pipe(
          Effect.mapError(toServiceError("Failed to create automation.")),
          Effect.flatMap((definition) =>
            normalizeCreatedDefinitionSchedule(definition, now).pipe(
              Effect.mapError(toServiceError("Failed to initialize automation schedule.")),
            ),
          ),
          Effect.tap((definition) => publish({ type: "definition-upserted", definition })),
        );
    };

    const update: AutomationServiceShape["update"] = (input) =>
      Effect.gen(function* () {
        const current = yield* requireDefinition(input.id);
        const updated = mergeDefinitionUpdate(current, input, new Date().toISOString());
        const saved = yield* automationRepository
          .saveDefinition(updated)
          .pipe(Effect.mapError(toServiceError("Failed to update automation.")));
        yield* publish({ type: "definition-upserted", definition: saved });
        return saved;
      });

    const deleteAutomation: AutomationServiceShape["delete"] = (input) =>
      automationRepository
        .archiveDefinition({ id: input.id, archivedAt: new Date().toISOString() })
        .pipe(
          Effect.mapError(toServiceError("Failed to delete automation.")),
          Effect.tap(() => publish({ type: "definition-deleted", automationId: input.id })),
        );

    const runNow: AutomationServiceShape["runNow"] = (input) =>
      Effect.gen(function* () {
        const definition = yield* requireDefinition(input.automationId);
        const now = new Date().toISOString();
        return yield* createRunForDefinition(definition, { type: "manual" }, now, now);
      });

    const cancelRun: AutomationServiceShape["cancelRun"] = (input) =>
      automationRepository
        .cancelRun({ ...input, now: new Date().toISOString() })
        .pipe(
          Effect.mapError(toServiceError("Failed to cancel automation run.")),
          Effect.tap((run) => publish({ type: "run-upserted", run })),
          Effect.map((run) => ({ run })),
        );

    const runDueOnce: AutomationServiceShape["runDueOnce"] = (input = {}) =>
      Effect.gen(function* () {
        const now = input.now ?? new Date().toISOString();
        const ownerId = input.leaseOwnerId ?? `automation-scheduler:${process.pid}`;
        const nowMs = Date.parse(now);
        const leaseExpiresAt = new Date(
          (Number.isFinite(nowMs) ? nowMs : Date.now()) + 55_000,
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
            Effect.gen(function* () {
              const scheduledFor = definition.nextRunAt ?? now;
              const nextRunAt = computeNextAutomationRunAt(definition.schedule, scheduledFor);
              yield* automationRepository
                .setDefinitionNextRunAt({
                  id: definition.id,
                  nextRunAt,
                  updatedAt: now,
                })
                .pipe(Effect.mapError(toServiceError("Failed to advance automation schedule.")));
              const result = yield* createRunForDefinition(
                definition,
                { type: "scheduled" },
                scheduledFor,
                now,
              );
              return Option.some(result);
            }).pipe(Effect.catch(() => Effect.succeed(Option.none()))),
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
      streamEvents: Stream.fromPubSub(events),
    } satisfies AutomationServiceShape;
  }),
);
