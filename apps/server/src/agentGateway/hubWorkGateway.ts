import type { ProjectId } from "@synara/contracts";
import type { AgentGatewayOperationRepositoryShape } from "./Services/AgentGatewayOperationRepository";
import type { ProjectionThreadMessageRepositoryShape } from "../persistence/Services/ProjectionThreadMessages";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns";
import {
  HubWorkProgress,
  ThreadId,
  TurnId,
  hubWorkItem,
  type HubWorkRecord,
  type SynaraCreateThreadsInput,
} from "@synara/contracts";
import { Effect, Option, Schema } from "effect";

import type { OrchestrationCommandReceiptRepositoryShape } from "../persistence/Services/OrchestrationCommandReceipts";
import type { GitCoreShape } from "../git/Services/GitCore";
import type { QueuedTurnPromotionRepositoryShape } from "../persistence/Services/QueuedTurnPromotions";
import type { ServerConfigShape } from "../config";
import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "../managedAttachmentPrincipal";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery";
import type { HubWorkRepositoryShape } from "../persistence/Services/HubWorkRepository";
import type { ManagedAttachmentRepositoryShape } from "../persistence/Services/ManagedAttachments";
import type { ProjectAgentRepositoryShape } from "../persistence/Services/ProjectAgentRepository";
import { isServerGroupsEnabled } from "../projectAgent/groupsBetaGate";
import { makeHubWorkService } from "../projectAgent/hubWorkService";
import type { ProjectAgentServiceShape } from "../projectAgent/Services/ProjectAgentService";
import type { makeCreateThreadsHandler } from "./creationCoordinator";
import { stableGatewayDigest } from "./creationUtils";
import { cloneDelegatedAttachments } from "./delegatedAttachments";
import { renderHubWorkPrompt, resolveHubWorkSource } from "./hubWorkSource";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import { errorText, readStringArg, ToolInputError } from "./toolInput";
import {
  GatewayToolError,
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime";

type CreateThreads = Effect.Success<ReturnType<typeof makeCreateThreadsHandler>>;

export function makeHubWorkGateway(dependencies: {
  readonly repository: HubWorkRepositoryShape;
  readonly creationOperations?: Pick<AgentGatewayOperationRepositoryShape, "getByScope">;
  readonly messages?: Pick<ProjectionThreadMessageRepositoryShape, "getByThreadAndMessageId">;
  readonly projectionTurns?: Pick<ProjectionTurnRepositoryShape, "getByTurnId">;
  readonly commandReceipts?: Pick<OrchestrationCommandReceiptRepositoryShape, "getByCommandId">;
  readonly git: Pick<GitCoreShape, "readBranchContext">;
  readonly queuedTurnPromotions?: Pick<QueuedTurnPromotionRepositoryShape, "listPendingThreadIds">;
  readonly projectAgentRepository: ProjectAgentRepositoryShape;
  readonly projectAgentService: ProjectAgentServiceShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly attachments: ManagedAttachmentRepositoryShape;
  readonly serverConfig: ServerConfigShape;
  readonly createThreads: CreateThreads;
}) {
  const { repository, projectAgentRepository, projectAgentService, snapshotQuery } = dependencies;
  const service = makeHubWorkService({
    repository,
    projectAgentRepository,
    projectAgentService,
    snapshotQuery,
    ...(dependencies.messages ? { messages: dependencies.messages } : {}),
    ...(dependencies.commandReceipts ? { commandReceipts: dependencies.commandReceipts } : {}),
    ...(dependencies.queuedTurnPromotions
      ? { queuedTurnPromotions: dependencies.queuedTurnPromotions }
      : {}),
  });
  const principalFor = (context: ToolContext) =>
    projectAgentService.resolvePrincipalForThread(ThreadId.makeUnsafe(context.callerThreadId));

  const assertWorkAuthority = (record: HubWorkRecord) =>
    Effect.gen(function* () {
      if (!isServerGroupsEnabled())
        return yield* Effect.fail(
          new GatewayToolError("capability_denied", "Hubs are available in Synara Beta."),
        );
      const config = yield* projectAgentRepository.getConfig(record.projectId);
      const current = yield* repository.get(record.id);
      if (
        Option.isNone(config) ||
        !config.value.enabled ||
        config.value.pausedAt !== null ||
        config.value.archivedAt !== null ||
        config.value.coordinatorThreadId !== record.sourceThreadId ||
        current?.state !== "starting"
      ) {
        return yield* Effect.fail(
          new GatewayToolError("hub_work_inactive", "Hub work is no longer authorized to start."),
        );
      }
      yield* projectAgentService.assertCallerMayCreateThreadInProject({
        callerThreadId: record.sourceThreadId,
        targetProjectId: record.targetProjectId,
      });
    }).pipe(
      Effect.mapError((error) =>
        error instanceof GatewayToolError
          ? error
          : new GatewayToolError("hub_work_inactive", errorText(error)),
      ),
    );

  const hasUnfinishedCreation = (record: HubWorkRecord) =>
    Effect.gen(function* () {
      if (!dependencies.creationOperations) return false;
      const operation = yield* dependencies.creationOperations.getByScope({
        callerThreadId: record.sourceThreadId,
        callerTurnId: `hub-work:${record.id}`,
        operationKind: "create_threads",
      });
      return (
        operation !== null && operation.status !== "failed" && operation.status !== "completed"
      );
    });

  const start = (record: HubWorkRecord) =>
    Effect.gen(function* () {
      // A started worker may still exist while its link transaction is rolled back.
      // Keep its reservation until the creation ledger confirms cleanup; replaying a
      // nonterminal saga here would also block the scanner waiting for that saga.
      if (yield* hasUnfinishedCreation(record)) return;
      const spec = record.creationSpec;
      const result = yield* dependencies.createThreads(
        {
          requestId: record.id,
          threads: [
            {
              ...spec,
              notifyCreatorOnComplete: false,
              projectId: record.targetProjectId,
              prompt: renderHubWorkPrompt({
                workItemId: record.id,
                brief: spec.prompt,
                sourceMessages: record.sourceMessages,
              }),
            },
          ],
        },
        {
          kind: "hub-work",
          workItemId: record.id,
          batchId: `hub-work-batch:${stableGatewayDigest({ projectId: record.projectId, scopeKey: record.scopeKey }, 40)}`,
          callerThreadId: record.sourceThreadId,
          sourceTurnId: record.delegationTurnId ?? record.sourceMessages[0]?.turnId ?? null,
          assertAuthority: () => assertWorkAuthority(record),
          prepareAttachments: (targetThreadId, targetMessageId) =>
            cloneDelegatedAttachments({
              sourceMessages: record.sourceMessages,
              targetThreadId,
              targetMessageId,
              dispatchKey: record.id,
              attachmentsDir: dependencies.serverConfig.attachmentsDir,
              repository: dependencies.attachments,
              principal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
            }),
          recordWorker: (workerThreadId) =>
            service.attachWorker({ workItemId: record.id, workerThreadId }).pipe(Effect.asVoid),
        },
      );
      if (result.isError) {
        if (yield* hasUnfinishedCreation(record)) return;
        const content = result.content.find((entry) => entry.type === "text");
        yield* service.setState({
          workItemId: record.id,
          state: "failed",
          resultSummary: (content?.type === "text"
            ? content.text
            : "Worker creation failed."
          ).slice(0, 4_000),
        });
      }
    });

  const processProjectQueue = (projectId: ProjectId) =>
    Effect.gen(function* () {
      yield* service.reconcile(projectId);
      const config = yield* projectAgentRepository.getConfig(projectId);
      if (
        Option.isNone(config) ||
        !config.value.enabled ||
        config.value.pausedAt !== null ||
        config.value.archivedAt !== null
      )
        return;
      const records = yield* repository.list(projectId);
      for (const record of records.filter(
        (item) => item.state === "starting" && item.workerThreadId === null,
      ))
        yield* start(record);
      let claimed = yield* service.claimNext(projectId);
      while (claimed) {
        yield* start(claimed);
        claimed = yield* service.claimNext(projectId);
      }
    });

  // SQL owns capacity. A damaged Hub must not stop every other Hub's queue.
  const tick = Effect.gen(function* () {
    if (!isServerGroupsEnabled()) return;
    const configs = yield* projectAgentRepository.listConfigs();
    for (const { projectId } of configs) {
      yield* processProjectQueue(projectId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Hub queue scan failed", { projectId, error: errorText(error) }),
        ),
      );
    }
  });

  const submit = (input: SynaraCreateThreadsInput, context: ToolContext) =>
    Effect.gen(function* () {
      if (!isServerGroupsEnabled()) return null;
      const principal = yield* principalFor(context);
      if (principal.kind !== "coordinator") return null;
      yield* context.assertCallerTurnActive();
      const sourcesByTask = yield* Effect.forEach(input.threads, (spec) =>
        resolveHubWorkSource({
          snapshotQuery,
          ...(dependencies.projectionTurns
            ? { projectionTurns: dependencies.projectionTurns }
            : {}),
          callerThreadId: context.callerThreadId,
          callerTurnId: context.callerTurnId,
          ...(spec.contextMessageIds !== undefined
            ? { contextMessageIds: spec.contextMessageIds }
            : {}),
        }),
      );
      const sourceMessages = [
        ...new Map(sourcesByTask.flat().map((message) => [message.messageId, message])).values(),
      ];
      const caller = yield* snapshotQuery.getThreadShellById(
        ThreadId.makeUnsafe(context.callerThreadId),
      );
      if (Option.isNone(caller))
        return yield* Effect.fail(new ToolInputError("Coordinator thread was not found."));
      const inheritedRuntimeMode =
        caller.value.runtimeMode === "auto" ? "approval-required" : caller.value.runtimeMode;
      const tasks = [];
      for (const [taskIndex, spec] of input.threads.entries()) {
        const project = yield* snapshotQuery.getProjectShellById(
          spec.projectId ?? principal.projectId,
        );
        if (Option.isNone(project))
          return yield* Effect.fail(new ToolInputError("Target project was not found."));
        // Repository workers default to isolated worktrees; a Hub's general workspace stays local.
        const repositoryContext =
          spec.environment === undefined && project.value.kind === "project"
            ? yield* dependencies.git.readBranchContext(project.value.workspaceRoot)
            : null;
        const environment = spec.environment ?? (repositoryContext?.isRepo ? "worktree" : "local");
        tasks.push({
          spec: {
            ...spec,
            environment,
            runtimeMode: spec.runtimeMode ?? inheritedRuntimeMode,
            contextMessageIds: sourcesByTask[taskIndex]!.map((message) => message.messageId),
          },
        });
      }
      const result = yield* service.submit({
        callerThreadId: ThreadId.makeUnsafe(context.callerThreadId),
        ...(context.callerTurnId ? { callerTurnId: TurnId.makeUnsafe(context.callerTurnId) } : {}),
        requestId: input.requestId,
        sourceMessages,
        tasks,
      });
      return mcpToolResultJson({
        requestId: input.requestId,
        replayed: result.replayed,
        acceptedCount: result.items.length,
        status: "accepted",
        workItems: result.items.map(hubWorkItem),
      });
    }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))));

  const tools: ToolEntry[] = [
    {
      requiredCapability: "thread:read",
      definition: {
        name: "synara_hub_list_work",
        description:
          "Read durable Hub task cards, queue state and progress revisions for your Hub.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { title: "Read Hub work", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: (_args, context) =>
        Effect.gen(function* () {
          const principal = yield* principalFor(context);
          if (principal.kind === "user" || principal.kind === "unmanaged")
            return yield* Effect.fail(new ToolInputError("This thread does not belong to a Hub."));
          return mcpToolResultJson({
            workItems: yield* service.list(principal.projectId, principal),
          });
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
    },
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "synara_hub_update_progress",
        description:
          "Persist your own Hub task checklist. Pass the last progress revision (0 initially). Checklist completion does not finish the task or release its worker slot.",
        inputSchema: {
          type: "object",
          properties: {
            workItemId: { type: "string" },
            expectedRevision: { type: "integer", minimum: 0 },
            summary: { type: "string", maxLength: 2000 },
            steps: {
              type: "array",
              maxItems: 32,
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  text: { type: "string" },
                  status: { type: "string", enum: ["pending", "inProgress", "completed"] },
                },
                required: ["id", "text", "status"],
                additionalProperties: false,
              },
            },
          },
          required: ["workItemId", "expectedRevision", "steps"],
          additionalProperties: false,
        },
        annotations: { title: "Update Hub progress", ...WRITE_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const progress = yield* Schema.decodeUnknownEffect(HubWorkProgress)({
            revision: args.expectedRevision,
            steps: args.steps,
            ...(args.summary !== undefined ? { summary: args.summary } : {}),
          });
          const result = yield* service.updateProgress({
            callerThreadId: ThreadId.makeUnsafe(context.callerThreadId),
            workItemId: readStringArg(args, "workItemId", { required: true })!,
            expectedRevision: progress.revision,
            steps: progress.steps,
            ...(progress.summary !== undefined ? { summary: progress.summary } : {}),
          });
          return mcpToolResultJson(hubWorkItem(result));
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
    },
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "synara_hub_cancel_work",
        description:
          "Cancel queued or idle Hub work. Stop active workers using the existing interrupt tool before cancelling.",
        inputSchema: {
          type: "object",
          properties: { workItemId: { type: "string" } },
          required: ["workItemId"],
          additionalProperties: false,
        },
        annotations: { title: "Cancel Hub work", ...WRITE_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const principal = yield* principalFor(context);
          return mcpToolResultJson(
            hubWorkItem(
              yield* service.cancel(
                { workItemId: readStringArg(args, "workItemId", { required: true })! },
                principal,
              ),
            ),
          );
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
    },
  ];
  const recover = Effect.gen(function* () {
    if (!isServerGroupsEnabled()) return;
    for (const projectId of yield* repository.listPendingProjects())
      yield* service.recoverFollowupAdmissions(projectId);
  });
  return { submit, tick, tools, service, recover };
}
