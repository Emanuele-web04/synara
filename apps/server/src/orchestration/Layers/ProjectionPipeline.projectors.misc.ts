// Purpose: Non-thread-timeline projector closures (project metadata, checkpoints,
//   pending approvals, runtime read model) plus the runtime read-model loader they
//   close over.
// Layer: dependency-parameterized projector closures; built via makeMiscProjectors(deps).
// Exports: makeMiscProjectors.

import { Effect, Option } from "effect";

import {
  type ProjectionThreadRuntime,
} from "../../persistence/Services/ProjectionThreadRuntime.ts";
import { applyProjectMetadataProjection } from "../projectMetadataProjection.ts";
import type { ProjectorDefinition } from "./ProjectionPipeline.types.ts";
import type { ProjectionProjectorDeps } from "./ProjectionPipeline.projectors.ts";
import {
  clampRuntimeTail,
  emptyRuntimeReadModel,
  extractActivityRequestId,
  isStalePendingApprovalFailure,
  upsertById,
} from "./ProjectionPipeline.helpers.ts";

export const makeMiscProjectors = (deps: ProjectionProjectorDeps) => {
  const {
    projectionProjectRepository,
    projectionThreadRuntimeRepository,
    projectionPendingApprovalRepository,
  } = deps;

  const applyProjectsProjection: ProjectorDefinition["apply"] = (event, _attachmentSideEffects) =>
    event.type === "project.created" ||
    event.type === "project.meta-updated" ||
    event.type === "project.deleted"
      ? applyProjectMetadataProjection({
          event,
          projectionProjectRepository,
        }).pipe(Effect.asVoid)
      : Effect.void;

  const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

  const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.activity-appended": {
          const activity = event.payload.activity;
          if (
            activity.kind !== "approval.requested" &&
            activity.kind !== "approval.resolved" &&
            activity.kind !== "provider.approval.respond.failed"
          ) {
            return;
          }
          const requestId =
            extractActivityRequestId(activity.payload) ?? event.metadata.requestId ?? null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          });
          if (
            activity.kind === "approval.resolved" ||
            (activity.kind === "provider.approval.respond.failed" &&
              isStalePendingApprovalFailure(activity.payload))
          ) {
            const resolvedDecisionRaw =
              typeof activity.payload === "object" &&
              activity.payload !== null &&
              "decision" in activity.payload
                ? (activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow) ? existingRow.value.turnId : activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : activity.createdAt,
              resolvedAt: activity.createdAt,
            });
            return;
          }
          if (activity.kind !== "approval.requested") {
            return;
          }
          if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
            return;
          }
          // Only approval requests belong in this table; user-input requests are
          // derived from thread activities when refreshing the shell summary.
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: event.payload.threadId,
            turnId: activity.turnId,
            status: "pending",
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "thread.approval-response-requested": {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: event.payload.requestId,
          });
          yield* projectionPendingApprovalRepository.upsert({
            requestId: event.payload.requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: "resolved",
            decision: event.payload.decision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: event.payload.createdAt,
          });
          return;
        }

        default:
          return;
      }
    });

  const loadRuntimeReadModel = (threadId: ProjectionThreadRuntime["threadId"]) =>
    projectionThreadRuntimeRepository
      .getReadModelByThreadId({ threadId })
      .pipe(Effect.map((option) => (Option.isSome(option) ? option.value : null)));

  const applyThreadRuntimeProjection: ProjectorDefinition["apply"] = (event, _side) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.runtime-provision-requested": {
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          const next: ProjectionThreadRuntime = existing
            ? {
                ...existing,
                targetKind: event.payload.targetKind,
                provider: event.payload.provider,
                role: event.payload.role,
                status: "provisioning",
                updatedAt: event.payload.requestedAt,
              }
            : emptyRuntimeReadModel({
                threadId: event.payload.threadId,
                targetKind: event.payload.targetKind,
                provider: event.payload.provider,
                role: event.payload.role,
                status: "provisioning",
                updatedAt: event.payload.requestedAt,
              });
          yield* projectionThreadRuntimeRepository.upsertReadModel(next);
          return;
        }

        case "thread.runtime-instance-created": {
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          const instance = {
            id: event.payload.instanceId,
            provider: event.payload.provider,
            status: event.payload.status,
            rootPath: event.payload.rootPath,
            failureReason: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.createdAt,
          };
          yield* projectionThreadRuntimeRepository.upsertInstance({
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            provider: event.payload.provider,
            status: event.payload.status,
            rootPath: event.payload.rootPath,
            failureReason: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.createdAt,
          });
          const base =
            existing ??
            emptyRuntimeReadModel({
              threadId: event.payload.threadId,
              targetKind: "remote-runtime",
              provider: event.payload.provider,
              role: "agent",
              status: event.payload.status,
              updatedAt: event.payload.createdAt,
            });
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...base,
            provider: event.payload.provider,
            runtimeInstanceId: event.payload.instanceId,
            status: event.payload.status,
            rootPath: event.payload.rootPath,
            instance,
            updatedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.runtime-instance-state-changed": {
          yield* projectionThreadRuntimeRepository.upsertInstance({
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            provider: (yield* loadRuntimeReadModel(event.payload.threadId))?.provider ?? "local",
            status: event.payload.status,
            rootPath: event.payload.rootPath ?? null,
            failureReason: event.payload.failureReason ?? null,
            createdAt: event.payload.updatedAt,
            updatedAt: event.payload.updatedAt,
          });
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            status: event.payload.status,
            rootPath: event.payload.rootPath ?? existing.rootPath,
            instance:
              existing.instance !== null && existing.instance.id === event.payload.instanceId
                ? {
                    ...existing.instance,
                    status: event.payload.status,
                    rootPath: event.payload.rootPath ?? existing.instance.rootPath,
                    failureReason: event.payload.failureReason ?? null,
                    updatedAt: event.payload.updatedAt,
                  }
                : existing.instance,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-process-started": {
          yield* projectionThreadRuntimeRepository.upsertProcess({
            processId: event.payload.processId,
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            role: event.payload.role,
            command: event.payload.command,
            status: "running",
            exitCode: null,
            failureReason: null,
            tail: null,
            startedAt: event.payload.startedAt,
            exitedAt: null,
          });
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            processes: upsertById(existing.processes, {
              id: event.payload.processId,
              role: event.payload.role,
              command: event.payload.command,
              status: "running",
              exitCode: null,
              failureReason: null,
              startedAt: event.payload.startedAt,
              exitedAt: null,
            }),
            lastActivityAt: event.payload.startedAt,
            updatedAt: event.payload.startedAt,
          });
          return;
        }

        case "thread.runtime-process-output": {
          // Stream-only: keep `lastActivityAt` fresh and stash a bounded tail on
          // the operational process row. Never persist a row per output line.
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            lastActivityAt: event.payload.occurredAt,
            updatedAt: event.payload.occurredAt,
          });
          return;
        }

        case "thread.runtime-process-completed": {
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          yield* projectionThreadRuntimeRepository.upsertProcess({
            processId: event.payload.processId,
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            role:
              existing?.processes.find((process) => process.id === event.payload.processId)?.role ??
              "exec",
            command:
              existing?.processes.find((process) => process.id === event.payload.processId)
                ?.command ?? null,
            status: event.payload.status,
            exitCode: event.payload.exitCode,
            failureReason: event.payload.failureReason ?? null,
            tail:
              event.payload.tail === undefined || event.payload.tail === null
                ? null
                : clampRuntimeTail(event.payload.tail),
            startedAt:
              existing?.processes.find((process) => process.id === event.payload.processId)
                ?.startedAt ?? event.payload.exitedAt,
            exitedAt: event.payload.exitedAt,
          });
          if (existing === null) {
            return;
          }
          const previousProcess = existing.processes.find(
            (process) => process.id === event.payload.processId,
          );
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            processes: upsertById(existing.processes, {
              id: event.payload.processId,
              role: previousProcess?.role ?? "exec",
              command: previousProcess?.command ?? null,
              status: event.payload.status,
              exitCode: event.payload.exitCode,
              failureReason: event.payload.failureReason,
              startedAt: previousProcess?.startedAt ?? event.payload.exitedAt,
              exitedAt: event.payload.exitedAt,
            }),
            lastActivityAt: event.payload.exitedAt,
            updatedAt: event.payload.exitedAt,
          });
          return;
        }

        case "thread.runtime-route-exposed": {
          yield* projectionThreadRuntimeRepository.upsertRoute({
            routeId: event.payload.routeId,
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            port: event.payload.port,
            url: event.payload.url,
            label: event.payload.label ?? null,
            exposedAt: event.payload.exposedAt,
          });
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            routes: upsertById(existing.routes, {
              id: event.payload.routeId,
              port: event.payload.port,
              url: event.payload.url,
              label: event.payload.label,
              exposedAt: event.payload.exposedAt,
            }),
            updatedAt: event.payload.exposedAt,
          });
          return;
        }

        case "thread.runtime-snapshot-created": {
          yield* projectionThreadRuntimeRepository.upsertSnapshot({
            snapshotId: event.payload.snapshotId,
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            label: event.payload.label ?? null,
            secretTainted: event.payload.secretTainted ?? false,
            createdAt: event.payload.createdAt,
          });
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            snapshots: upsertById(existing.snapshots, {
              id: event.payload.snapshotId,
              label: event.payload.label,
              secretTainted: event.payload.secretTainted,
              createdAt: event.payload.createdAt,
            }),
            updatedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.runtime-lease-renewed": {
          yield* projectionThreadRuntimeRepository.upsertLease({
            leaseId: event.payload.leaseId,
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            reason: event.payload.reason,
            acquiredAt: event.payload.acquiredAt,
            renewedAt: event.payload.renewedAt ?? null,
            expiresAt: event.payload.expiresAt ?? null,
            releasedAt: event.payload.released ? (event.payload.renewedAt ?? null) : null,
          });
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          const activeLease = {
            id: event.payload.leaseId,
            reason: event.payload.reason,
            acquiredAt: event.payload.acquiredAt,
            renewedAt: event.payload.renewedAt,
            expiresAt: event.payload.expiresAt,
          };
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            leases: event.payload.released
              ? existing.leases.filter((lease) => lease.id !== event.payload.leaseId)
              : upsertById(existing.leases, activeLease),
            lastActivityAt: event.payload.renewedAt ?? existing.lastActivityAt,
            updatedAt: event.payload.renewedAt ?? event.payload.acquiredAt,
          });
          return;
        }

        case "thread.runtime-destroyed": {
          yield* projectionThreadRuntimeRepository.upsertInstance({
            instanceId: event.payload.instanceId,
            threadId: event.payload.threadId,
            provider: (yield* loadRuntimeReadModel(event.payload.threadId))?.provider ?? "local",
            status: "destroyed",
            rootPath: null,
            failureReason: null,
            createdAt: event.payload.destroyedAt,
            updatedAt: event.payload.destroyedAt,
          });
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            status: "destroyed",
            instance:
              existing.instance !== null
                ? {
                    ...existing.instance,
                    status: "destroyed",
                    updatedAt: event.payload.destroyedAt,
                  }
                : existing.instance,
            leases: [],
            updatedAt: event.payload.destroyedAt,
          });
          return;
        }

        case "thread.runtime-failed": {
          if (event.payload.instanceId !== null) {
            yield* projectionThreadRuntimeRepository.upsertInstance({
              instanceId: event.payload.instanceId,
              threadId: event.payload.threadId,
              provider: (yield* loadRuntimeReadModel(event.payload.threadId))?.provider ?? "local",
              status: "failed",
              rootPath: null,
              failureReason: event.payload.failureReason,
              createdAt: event.payload.occurredAt,
              updatedAt: event.payload.occurredAt,
            });
          }
          const existing = yield* loadRuntimeReadModel(event.payload.threadId);
          if (existing === null) {
            return;
          }
          yield* projectionThreadRuntimeRepository.upsertReadModel({
            ...existing,
            status: "failed",
            instance:
              existing.instance !== null
                ? {
                    ...existing.instance,
                    status: "failed",
                    failureReason: event.payload.failureReason,
                    updatedAt: event.payload.occurredAt,
                  }
                : existing.instance,
            updatedAt: event.payload.occurredAt,
          });
          return;
        }

        default:
          return;
      }
    });

  return {
    applyProjectsProjection,
    applyCheckpointsProjection,
    applyPendingApprovalsProjection,
    applyThreadRuntimeProjection,
  };
};
