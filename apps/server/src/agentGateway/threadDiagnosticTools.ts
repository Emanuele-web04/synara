import {
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ThreadDiagnosticsQueryShape } from "../diagnostics/Services/ThreadDiagnosticsQuery.ts";
import {
  PROVIDER_COMMAND_REACTOR_CONSUMER,
  type OrchestrationEventDeliveryRepositoryShape,
} from "../persistence/Services/OrchestrationEventDeliveries.ts";
import type { OrchestrationEventStoreShape } from "../persistence/Services/OrchestrationEventStore.ts";
import {
  PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED,
  type ProviderRuntimeEventRepositoryShape,
} from "../persistence/Services/ProviderRuntimeEvents.ts";
import {
  decodeDiagnosticCursor,
  diagnosticFilterFingerprint,
  encodeDiagnosticCursor,
} from "./diagnosticCursor.ts";
import { sanitizeDiagnosticValue } from "./diagnosticSanitizer.ts";
import {
  groupDiagnosticEvents,
  readDiagnosticPageLimit,
  shapeDiagnosticEvents,
} from "./threadDiagnosticSummary.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { summarizeThreadDetail } from "./threadSummary.ts";
import {
  errorText,
  readBooleanArg,
  readStringArg,
  readStringArrayArg,
  ToolInputError,
} from "./toolInput.ts";
import { READ_ONLY_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime.ts";

const DIAGNOSTIC_EVENT_SCAN_CHUNK_SIZE = 250;
const DIAGNOSTIC_EVENT_MAX_COALESCING_SCAN = 10_000;

export function makeThreadDiagnosticTools(input: {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly diagnostics: ThreadDiagnosticsQueryShape;
  readonly eventStore: OrchestrationEventStoreShape;
  readonly providerRuntimeEvents: ProviderRuntimeEventRepositoryShape;
  readonly eventDeliveries: OrchestrationEventDeliveryRepositoryShape;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown, never>;
}): ReadonlyArray<ToolEntry> {
  const readActivity: ToolEntry = {
    requiredCapability: "diagnostics:read",
    definition: {
      name: "synara_read_thread_activity",
      description:
        "Read a stable, paginated page of projected thread activity. Returns newest-last rows and an opaque cursor for older evidence.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          cursor: { type: "string" },
          limit: { type: "number", description: "Default 50, max 200." },
          turnId: { type: "string" },
          kinds: { type: "array", items: { type: "string" } },
          includeDetails: {
            type: "boolean",
            description: "Include bounded, redacted activity payloads.",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Read thread activity", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        yield* input.requireThreadShell(threadId);
        const turnId = readStringArg(args, "turnId") ?? null;
        const kinds = readStringArrayArg(args, "kinds") ?? [];
        const filterFingerprint = diagnosticFilterFingerprint({ turnId, kinds });
        const cursor = decodeDiagnosticCursor(readStringArg(args, "cursor"), {
          kind: "activity",
          threadId,
          filterFingerprint,
        });
        const requestedLimit = readDiagnosticPageLimit(args);
        const includeDetails = readBooleanArg(args, "includeDetails") ?? false;
        const limit = includeDetails ? Math.min(requestedLimit, 50) : requestedLimit;
        const activityCoverage = yield* input.diagnostics.getActivityCoverage(threadId);
        const highWaterSequence = cursor?.highWaterSequence ?? activityCoverage.highWaterSequence;
        const rows = yield* input.diagnostics.listActivities({
          threadId,
          throughSequenceInclusive: highWaterSequence,
          ...(cursor ? { beforeSequenceExclusive: cursor.beforeSequence } : {}),
          limit: limit + 1,
          ...(turnId ? { turnId } : {}),
          ...(kinds.length > 0 ? { kinds } : {}),
        });
        const page = rows.slice(0, limit);
        const oldest = page[page.length - 1];
        return mcpToolResultJson({
          threadId,
          activities: page
            .map((row) => ({
              sequence: row.sequence,
              activityId: row.activityId,
              turnId: row.turnId,
              tone: row.tone,
              kind: row.kind,
              summary: row.summary,
              createdAt: row.createdAt,
              ...(includeDetails ? { detail: sanitizeDiagnosticValue(row.payload) } : {}),
            }))
            .reverse(),
          coverage: {
            source: "projection_thread_activities",
            highWaterSequence,
            sourceComplete: activityCoverage.unsequencedCount === 0,
            unsequencedCount: activityCoverage.unsequencedCount,
            pageHasOlder: rows.length > limit,
          },
          ...(limit !== requestedLimit ? { requestedLimit, appliedLimit: limit } : {}),
          ...(rows.length > limit && oldest
            ? {
                nextCursor: encodeDiagnosticCursor({
                  version: 1,
                  kind: "activity",
                  threadId,
                  filterFingerprint,
                  highWaterSequence,
                  beforeSequence: oldest.sequence,
                }),
              }
            : {}),
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const readEvents: ToolEntry = {
    requiredCapability: "diagnostics:read",
    definition: {
      name: "synara_read_thread_events",
      description:
        "Read a stable, paginated page from the durable orchestration event journal. Consecutive updates for the same message are coalesced without crossing intervening events.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          cursor: { type: "string" },
          limit: { type: "number", description: "Default 50, max 200." },
          eventTypes: { type: "array", items: { type: "string" } },
          payloadMode: { type: "string", enum: ["none", "summary", "full"] },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Read thread events", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        yield* input.requireThreadShell(threadId);
        const eventTypes = readStringArrayArg(args, "eventTypes") ?? [];
        const filterFingerprint = diagnosticFilterFingerprint({ eventTypes });
        const cursor = decodeDiagnosticCursor(readStringArg(args, "cursor"), {
          kind: "event",
          threadId,
          filterFingerprint,
        });
        const requestedLimit = readDiagnosticPageLimit(args);
        const payloadModeRaw = readStringArg(args, "payloadMode") ?? "summary";
        if (
          payloadModeRaw !== "none" &&
          payloadModeRaw !== "summary" &&
          payloadModeRaw !== "full"
        ) {
          throw new ToolInputError('Argument "payloadMode" must be "none", "summary", or "full".');
        }
        const limit = payloadModeRaw === "full" ? Math.min(requestedLimit, 25) : requestedLimit;
        const highWaterSequence =
          cursor?.highWaterSequence ??
          (yield* input.eventStore.getThreadHighWaterSequence(threadId));
        const scannedEvents: OrchestrationEvent[] = [];
        let scanBeforeSequence = cursor?.beforeSequence;
        let coalescingScanTruncated = false;
        while (scannedEvents.length < DIAGNOSTIC_EVENT_MAX_COALESCING_SCAN) {
          const scanLimit = Math.min(
            DIAGNOSTIC_EVENT_SCAN_CHUNK_SIZE,
            DIAGNOSTIC_EVENT_MAX_COALESCING_SCAN - scannedEvents.length,
          );
          const chunk = yield* input.eventStore.readThreadEvents({
            threadId,
            throughSequenceInclusive: highWaterSequence,
            ...(scanBeforeSequence !== undefined
              ? { beforeSequenceExclusive: scanBeforeSequence }
              : {}),
            limit: scanLimit,
            ...(eventTypes.length > 0 ? { eventTypes } : {}),
          });
          scannedEvents.push(...chunk);
          if (chunk.length < scanLimit) break;
          scanBeforeSequence = chunk[chunk.length - 1]?.sequence;
          if (groupDiagnosticEvents(scannedEvents).length > limit) break;
          if (scannedEvents.length === DIAGNOSTIC_EVENT_MAX_COALESCING_SCAN) {
            coalescingScanTruncated = true;
          }
        }
        const logicalEvents = shapeDiagnosticEvents(scannedEvents, payloadModeRaw);
        const page = logicalEvents.slice(-limit);
        const pageHasOlder = logicalEvents.length > limit || coalescingScanTruncated;
        const returnedGroups = groupDiagnosticEvents(scannedEvents).slice(0, limit);
        const returnedBoundarySequence = returnedGroups[returnedGroups.length - 1]?.oldestSequence;
        const nextBeforeSequence =
          coalescingScanTruncated && logicalEvents.length <= limit
            ? scannedEvents[scannedEvents.length - 1]?.sequence
            : returnedBoundarySequence;
        return mcpToolResultJson({
          threadId,
          events: page,
          coverage: {
            source: "orchestration_events",
            highWaterSequence,
            durableSourceComplete: true,
            pageHasOlder,
            ...(coalescingScanTruncated ? { coalescingScanTruncated: true } : {}),
          },
          ...(limit !== requestedLimit ? { requestedLimit, appliedLimit: limit } : {}),
          ...(pageHasOlder && nextBeforeSequence !== undefined
            ? {
                nextCursor: encodeDiagnosticCursor({
                  version: 1,
                  kind: "event",
                  threadId,
                  filterFingerprint,
                  highWaterSequence,
                  beforeSequence: nextBeforeSequence,
                }),
              }
            : {}),
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const readRuntimeEvents: ToolEntry = {
    requiredCapability: "diagnostics:read",
    definition: {
      name: "synara_read_thread_runtime_events",
      description:
        "Read retained provider-runtime events for one thread. This source has a global accepted-event retention cap; inspect coverage before treating absence as evidence.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          cursor: { type: "string" },
          limit: { type: "number", description: "Default 50, max 200." },
          turnId: { type: "string" },
          eventTypes: { type: "array", items: { type: "string" } },
          includeDetails: {
            type: "boolean",
            description: "Include bounded, redacted provider event fields, including raw metadata.",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Read thread runtime events", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        yield* input.requireThreadShell(threadId);
        const turnId = readStringArg(args, "turnId") ?? null;
        const eventTypes = readStringArrayArg(args, "eventTypes") ?? [];
        const filterFingerprint = diagnosticFilterFingerprint({ turnId, eventTypes });
        const cursor = decodeDiagnosticCursor(readStringArg(args, "cursor"), {
          kind: "runtime",
          threadId,
          filterFingerprint,
        });
        const requestedLimit = readDiagnosticPageLimit(args);
        const includeDetails = readBooleanArg(args, "includeDetails") ?? false;
        const limit = includeDetails ? Math.min(requestedLimit, 25) : requestedLimit;
        const runtimeCoverage = yield* input.providerRuntimeEvents.getThreadCoverage(threadId);
        const highWaterSequence = cursor?.highWaterSequence ?? runtimeCoverage.highWaterSequence;
        const rows = yield* input.providerRuntimeEvents.readThreadEvents({
          threadId,
          throughSequenceInclusive: highWaterSequence,
          ...(cursor ? { beforeSequenceExclusive: cursor.beforeSequence } : {}),
          limit: limit + 1,
          ...(turnId ? { turnId } : {}),
          ...(eventTypes.length > 0 ? { eventTypes } : {}),
        });
        const page = rows.slice(0, limit);
        const oldest = page[page.length - 1];
        return mcpToolResultJson({
          threadId,
          events: page
            .map(({ sequence, event }) => ({
              sequence,
              eventId: event.eventId,
              type: event.type,
              provider: event.provider,
              turnId: event.turnId ?? null,
              itemId: event.itemId ?? null,
              requestId: event.requestId ?? null,
              createdAt: event.createdAt,
              ...(includeDetails ? { detail: sanitizeDiagnosticValue(event) } : {}),
            }))
            .reverse(),
          coverage: {
            source: "provider_runtime_events",
            highWaterSequence,
            oldestRetainedSequence: runtimeCoverage.oldestSequence,
            retainedForThread: runtimeCoverage.retainedCount,
            globalAcceptedEventCap: PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED,
            sourceComplete: false,
            pageHasOlder: rows.length > limit,
          },
          ...(limit !== requestedLimit ? { requestedLimit, appliedLimit: limit } : {}),
          ...(rows.length > limit && oldest
            ? {
                nextCursor: encodeDiagnosticCursor({
                  version: 1,
                  kind: "runtime",
                  threadId,
                  filterFingerprint,
                  highWaterSequence,
                  beforeSequence: oldest.sequence,
                }),
              }
            : {}),
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const diagnoseThread: ToolEntry = {
    requiredCapability: "diagnostics:read",
    definition: {
      name: "synara_diagnose_thread",
      description:
        "Build one bounded forensic snapshot from projected status/messages/activity, durable events, provider delivery blockers, and operational stream incidents.",
      inputSchema: {
        type: "object",
        properties: { threadId: { type: "string" } },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Diagnose a Synara thread", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        yield* input.requireThreadShell(threadId);
        const detail = yield* input.snapshotQuery
          .getThreadDetailById(ThreadId.makeUnsafe(threadId))
          .pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new ToolInputError(`Thread "${threadId}" was not found.`)),
                onSome: Effect.succeed,
              }),
            ),
          );
        const [activityCoverage, eventHighWater, runtimeCoverage, blockers, incidents] =
          yield* Effect.all([
            input.diagnostics.getActivityCoverage(threadId),
            input.eventStore.getThreadHighWaterSequence(threadId),
            input.providerRuntimeEvents.getThreadCoverage(threadId),
            input.eventDeliveries.listBlockingDeliveries({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              threadId,
              limit: 20,
            }),
            input.diagnostics.listOperationalDiagnostics({ threadId, limit: 50 }),
          ]);
        const [activities, events, runtimeEvents] = yield* Effect.all([
          input.diagnostics.listActivities({
            threadId,
            throughSequenceInclusive: activityCoverage.highWaterSequence,
            limit: 50,
          }),
          input.eventStore.readThreadEvents({
            threadId,
            throughSequenceInclusive: eventHighWater,
            limit: 100,
          }),
          input.providerRuntimeEvents.readThreadEvents({
            threadId,
            throughSequenceInclusive: runtimeCoverage.highWaterSequence,
            limit: 100,
          }),
        ]);
        const findings = [
          ...(detail.session?.lastError
            ? [
                {
                  severity: "error",
                  code: "provider_session_error",
                  detail: detail.session.lastError,
                },
              ]
            : []),
          ...blockers.map((blocker) => ({
            severity: "error",
            code: "provider_delivery_blocked",
            detail: `Event ${blocker.eventSequence} is ${blocker.state} after ${blocker.attemptCount} attempt(s).`,
          })),
          ...incidents
            .filter((incident) => incident.severity !== "info")
            .map((incident) => ({
              severity: incident.severity,
              code: incident.code ?? incident.kind,
              detail: incident.detail,
            })),
        ];
        return mcpToolResultJson({
          thread: summarizeThreadDetail({
            thread: detail,
            callerThreadId: context.callerThreadId,
            messageLimit: 20,
            maxMessageChars: 2_000,
          }),
          findings,
          recentActivity: activities
            .map((activity) => ({
              sequence: activity.sequence,
              turnId: activity.turnId,
              kind: activity.kind,
              tone: activity.tone,
              summary: activity.summary,
              createdAt: activity.createdAt,
            }))
            .reverse(),
          recentEvents: shapeDiagnosticEvents(events, "summary"),
          recentRuntimeEvents: runtimeEvents
            .map(({ sequence, event }) => ({
              sequence,
              eventId: event.eventId,
              type: event.type,
              provider: event.provider,
              turnId: event.turnId ?? null,
              itemId: event.itemId ?? null,
              requestId: event.requestId ?? null,
              createdAt: event.createdAt,
            }))
            .reverse(),
          providerDeliveryBlockers: blockers.map((blocker) => ({
            ...blocker,
            lastError: sanitizeDiagnosticValue(blocker.lastError),
            lastReconciliationNote: sanitizeDiagnosticValue(blocker.lastReconciliationNote),
          })),
          operationalIncidents: incidents.map((incident) => ({
            ...incident,
            detail: sanitizeDiagnosticValue(incident.detail),
          })),
          coverage: {
            messages: { source: "projection_thread_messages", boundedToNewest: 2_000 },
            activity: {
              source: "projection_thread_activities",
              highWaterSequence: activityCoverage.highWaterSequence,
              sourceComplete: activityCoverage.unsequencedCount === 0,
              unsequencedCount: activityCoverage.unsequencedCount,
            },
            events: {
              source: "orchestration_events",
              highWaterSequence: eventHighWater,
              durableSourceComplete: true,
              returnedNewest: events.length,
            },
            operationalIncidents: {
              source: "operational_diagnostics",
              retentionDays: 30,
              globalCap: 10_000,
            },
            providerRuntimeRawEvents: {
              included: true,
              source: "provider_runtime_events",
              returnedNewest: runtimeEvents.length,
              highWaterSequence: runtimeCoverage.highWaterSequence,
              oldestRetainedSequence: runtimeCoverage.oldestSequence,
              retainedForThread: runtimeCoverage.retainedCount,
              globalAcceptedEventCap: PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED,
              sourceComplete: false,
              reason:
                "Provider runtime events have bounded global retention; absence is not proof that an event never occurred.",
            },
          },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  return [readActivity, readEvents, readRuntimeEvents, diagnoseThread];
}
