import { type OrchestrationEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadRuntimeRepository } from "../../persistence/Services/ProjectionThreadRuntime.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionThreadRuntimeRepositoryLive } from "../../persistence/Layers/ProjectionThreadRuntime.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  applyProjectMetadataProjection,
  advanceProjectMetadataSnapshotState,
} from "../projectMetadataProjection.ts";
import {
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import {
  type AttachmentSideEffects,
  ORCHESTRATION_PROJECTOR_NAMES,
  type ProjectorDefinition,
  REQUIRED_SNAPSHOT_PROJECTORS,
} from "./ProjectionPipeline.types.ts";
import {
  isThreadRuntimeEvent,
  shouldRefreshThreadShellSummary,
} from "./ProjectionPipeline.helpers.ts";
import { makeProjectionProjectors } from "./ProjectionPipeline.projectors.ts";

export { ORCHESTRATION_PROJECTOR_NAMES };

const runAttachmentSideEffects = Effect.fn(function* (sideEffects: AttachmentSideEffects) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = serverConfig.attachmentsDir;
  const attachmentRootEntries = yield* fileSystem
    .readDirectory(attachmentsRootDir, { recursive: false })
    .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

  // Deleted-thread cleanup removes every attachment owned by the thread.
  const removeDeletedThreadAttachmentEntry = Effect.fn(function* (
    threadSegment: string,
    entry: string,
  ) {
    const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) {
      return;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
    if (!attachmentId) {
      return;
    }
    const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
      return;
    }
    yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
      force: true,
    });
  });

  const deleteThreadAttachments = Effect.fn(function* (threadId: string) {
    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
        threadId,
      });
      return;
    }

    yield* Effect.forEach(
      attachmentRootEntries,
      (entry) => removeDeletedThreadAttachmentEntry(threadSegment, entry),
      {
        concurrency: 1,
      },
    );
  });

  const pruneThreadAttachmentEntry = Effect.fn(function* (
    threadSegment: string,
    keptThreadRelativePaths: Set<string>,
    entry: string,
  ) {
    const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (relativePath.length === 0 || relativePath.includes("/")) {
      return;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
    if (!attachmentId) {
      return;
    }
    const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
      return;
    }

    const absolutePath = path.join(attachmentsRootDir, relativePath);
    const fileInfo = yield* fileSystem
      .stat(absolutePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return;
    }

    if (!keptThreadRelativePaths.has(relativePath)) {
      yield* fileSystem.remove(absolutePath, { force: true });
    }
  });

  yield* Effect.forEach(
    sideEffects.deletedThreadIds,
    (threadId) => deleteThreadAttachments(threadId),
    { concurrency: 1 },
  );

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) => {
      if (sideEffects.deletedThreadIds.has(threadId)) {
        return Effect.void;
      }
      return Effect.gen(function* () {
        const threadSegment = toSafeThreadAttachmentSegment(threadId);
        if (!threadSegment) {
          yield* Effect.logWarning("skipping attachment prune for unsafe thread id", { threadId });
          return;
        }
        yield* Effect.forEach(
          attachmentRootEntries,
          (entry) => pruneThreadAttachmentEntry(threadSegment, keptThreadRelativePaths, entry),
          { concurrency: 1 },
        );
      });
    },
    { concurrency: 1 },
  );
});

const makeOrchestrationProjectionPipeline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const projectionStateRepository = yield* ProjectionStateRepository;
  const projectionProjectRepository = yield* ProjectionProjectRepository;
  const projectionThreadRepository = yield* ProjectionThreadRepository;
  const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
  const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
  const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
  const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
  const projectionThreadRuntimeRepository = yield* ProjectionThreadRuntimeRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  const {
    applyProjectsProjection,
    applyThreadsProjection,
    applyThreadShellSummariesProjection,
    applyThreadMessagesProjection,
    applyThreadProposedPlansProjection,
    applyThreadActivitiesProjection,
    applyThreadSessionsProjection,
    applyThreadTurnsProjection,
    applyCheckpointsProjection,
    applyPendingApprovalsProjection,
    applyThreadRuntimeProjection,
  } = makeProjectionProjectors({
    projectionProjectRepository,
    projectionThreadRepository,
    projectionThreadMessageRepository,
    projectionThreadProposedPlanRepository,
    projectionThreadActivityRepository,
    projectionThreadSessionRepository,
    projectionThreadRuntimeRepository,
    projectionTurnRepository,
    projectionPendingApprovalRepository,
  });


  const projectors: ReadonlyArray<ProjectorDefinition> = [
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.projects,
      phase: "hot",
      apply: applyProjectsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
      phase: "hot",
      apply: applyThreadMessagesProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
      phase: "hot",
      apply: applyThreadProposedPlansProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
      phase: "hot",
      apply: applyThreadActivitiesProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
      phase: "hot",
      apply: applyThreadSessionsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
      phase: "hot",
      apply: applyThreadTurnsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
      phase: "hot",
      apply: applyCheckpointsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
      phase: "hot",
      apply: applyPendingApprovalsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threads,
      phase: "hot",
      apply: applyThreadsProjection,
    },
    {
      // Instance-state is hot so runtime status is queryable immediately after
      // dispatch; `process-output` only updates a bounded tail / lastActivityAt.
      name: ORCHESTRATION_PROJECTOR_NAMES.threadRuntime,
      phase: "hot",
      shouldApply: isThreadRuntimeEvent,
      apply: applyThreadRuntimeProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadShellSummaries,
      phase: "deferred",
      shouldApply: shouldRefreshThreadShellSummary,
      apply: applyThreadShellSummariesProjection,
    },
  ];
  const projectsProjector = projectors.find(
    (projector) => projector.name === ORCHESTRATION_PROJECTOR_NAMES.projects,
  );

  // Project metadata changes only touch the project projection, so keep them
  // off the slower full-projector pass used by thread and runtime events.
  const selectProjectorsForEvent = (
    event: OrchestrationEvent,
    phase?: ProjectorDefinition["phase"],
  ): ReadonlyArray<ProjectorDefinition> => {
    const filterProjectors = (candidates: ReadonlyArray<ProjectorDefinition>) =>
      candidates.filter(
        (projector) =>
          (phase === undefined || projector.phase === phase) &&
          (projector.shouldApply?.(event) ?? true),
      );

    switch (event.type) {
      case "project.created":
      case "project.meta-updated":
      case "project.deleted":
        return projectsProjector
          ? filterProjectors([projectsProjector]).length > 0
            ? [projectsProjector]
            : []
          : filterProjectors(projectors);
      default:
        return filterProjectors(projectors);
    }
  };

  const runProjectorForEvent = (projector: ProjectorDefinition, event: OrchestrationEvent) =>
    Effect.gen(function* () {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(
        projector.apply(event, attachmentSideEffects).pipe(
          Effect.flatMap(() =>
            projectionStateRepository.upsert({
              projector: projector.name,
              lastAppliedSequence: event.sequence,
              updatedAt: event.occurredAt,
            }),
          ),
        ),
      );

      yield* runAttachmentSideEffects(attachmentSideEffects).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to apply projected attachment side-effects", {
            projector: projector.name,
            sequence: event.sequence,
            eventType: event.type,
            cause,
          }),
        ),
      );
    });

  const advanceProjectorStateToEvent = (
    projector: ProjectorDefinition,
    event: OrchestrationEvent,
  ) =>
    projectionStateRepository.upsert({
      projector: projector.name,
      lastAppliedSequence: event.sequence,
      updatedAt: event.occurredAt,
    });

  const bootstrapProjector = (projector: ProjectorDefinition) =>
    projectionStateRepository
      .getByProjector({
        projector: projector.name,
      })
      .pipe(
        Effect.flatMap((stateRow) =>
          Effect.gen(function* () {
            let pendingSkippedEvent: OrchestrationEvent | null = null;

            yield* Stream.runForEach(
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
              ),
              (event) => {
                if (!(projector.shouldApply?.(event) ?? true)) {
                  pendingSkippedEvent = event;
                  return Effect.void;
                }

                pendingSkippedEvent = null;
                return runProjectorForEvent(projector, event);
              },
            );

            // Preserve the replay cursor across trailing non-matching events without paying the
            // full projector transaction/apply cost for bootstrap no-ops.
            if (pendingSkippedEvent) {
              yield* advanceProjectorStateToEvent(projector, pendingSkippedEvent);
            }
          }),
        ),
      );

  const advanceSnapshotProjectorStates = (event: OrchestrationEvent) =>
    sql.withTransaction(
      Effect.forEach(
        REQUIRED_SNAPSHOT_PROJECTORS,
        (projector) =>
          projectionStateRepository.upsert({
            projector,
            lastAppliedSequence: event.sequence,
            updatedAt: event.occurredAt,
          }),
        { concurrency: 1 },
      ),
    );

  const projectMetadataEvent: OrchestrationProjectionPipelineShape["projectMetadataEvent"] = (
    event,
  ) =>
    applyProjectMetadataProjection({
      event,
      projectionProjectRepository,
    }).pipe(
      Effect.flatMap(() =>
        advanceProjectMetadataSnapshotState({
          event,
          projectionStateRepository,
        }),
      ),
      Effect.asVoid,
    );

  const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
    Effect.forEach(
      selectProjectorsForEvent(event),
      (projector) => runProjectorForEvent(projector, event),
      {
        concurrency: 1,
      },
    ).pipe(
      Effect.flatMap(() => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
          case "project.deleted":
            return advanceSnapshotProjectorStates(event);
          default:
            return Effect.void;
        }
      }),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
      ),
    );

  const projectHotEvent: OrchestrationProjectionPipelineShape["projectHotEvent"] = (event) =>
    Effect.forEach(
      selectProjectorsForEvent(event, "hot"),
      (projector) => runProjectorForEvent(projector, event),
      {
        concurrency: 1,
      },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectHotEvent:query")(sqlError)),
      ),
    );

  const projectDeferredEvent: OrchestrationProjectionPipelineShape["projectDeferredEvent"] = (
    event,
  ) =>
    Effect.forEach(
      selectProjectorsForEvent(event, "deferred"),
      (projector) => runProjectorForEvent(projector, event),
      {
        concurrency: 1,
      },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(
          toPersistenceSqlError("ProjectionPipeline.projectDeferredEvent:query")(sqlError),
        ),
      ),
    );

  const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.forEach(
    projectors,
    bootstrapProjector,
    { concurrency: 1 },
  ).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ServerConfig, serverConfig),
    Effect.asVoid,
    Effect.tap(() =>
      Effect.log("orchestration projection pipeline bootstrapped").pipe(
        Effect.annotateLogs({ projectors: projectors.length }),
      ),
    ),
    Effect.catchTag("SqlError", (sqlError) =>
      Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
    ),
  );

  return {
    bootstrap,
    projectEvent,
    projectHotEvent,
    projectDeferredEvent,
    projectMetadataEvent,
  } satisfies OrchestrationProjectionPipelineShape;
});

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline,
).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionThreadRuntimeRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
