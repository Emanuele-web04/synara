// FILE: providerHistory/externalHistorySync.ts
// Purpose: Opt-in server-side synchronization for external Devin history
// (DHI-10). One fenced supervisor scans each enabled source on its own
// interval — local SQLite catalog every 60s, Cloud first-page update scan every
// 120s ±20% jitter — and routes new or changed sessions through the same
// `importHistory` coordinator as manual import, so dedup, tombstones, and
// immutable batches all apply unchanged. ATIF exports are static files and
// have no change-sync. Read-only towards every provider.
// Exports: makeExternalHistorySyncLoop, planExternalHistorySync (for tests).

import * as crypto from "node:crypto";

import { Option, Duration, Effect, Schema } from "effect";

import {
  ProjectId,
  type ExternalHistorySessionDescriptor,
  type OrchestrationThreadShell,
} from "@synara/contracts";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery";
import type {
  ExternalHistoryLinkRecord,
  ExternalHistoryRepositoryShape,
} from "../persistence/Services/ExternalHistory";
import type { ServerSettingsShape } from "../serverSettings.ts";
import { makeExternalHistoryService } from "./externalHistoryService.ts";

const WAKE_INTERVAL_MS = 15_000;
const LOCAL_SCAN_INTERVAL_MS = 60_000;
const CLOUD_SCAN_INTERVAL_MS = 120_000;
const CLOUD_SCAN_JITTER = 0.2;
const DISCOVERY_LIMIT = 50;
const ATIF_PREFIX = "devin-atif";

const FALLBACK_MODEL_SELECTION = { provider: "devin", model: "adaptive" } as const;

export interface ExternalHistorySyncOptions {
  readonly repository: ExternalHistoryRepositoryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly serverSettings: ServerSettingsShape;
  readonly homeDir: string;
}

export type ExternalHistorySyncPlan =
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "tombstone" }
  | { readonly kind: "import"; readonly projectId: ProjectId }
  | { readonly kind: "inbox" }
  | { readonly kind: "incremental"; readonly projectId: ProjectId };

const BUSY_SESSION_STATUSES: ReadonlySet<string> = new Set(["starting", "running"]);

/**
 * Pure decision table for one upstream session on one scan. Exported so the
 * dedup / tombstone / pause cases can be unit-tested without a live store.
 */
export const planExternalHistorySync = (input: {
  readonly link: ExternalHistoryLinkRecord | null;
  readonly threadShell: OrchestrationThreadShell | null;
  readonly matchedProjectId: ProjectId | null;
  readonly sessionRevision: string | null;
}): ExternalHistorySyncPlan => {
  const { link, threadShell, matchedProjectId, sessionRevision } = input;
  if (link !== null && link.suppressedAt !== null) {
    return { kind: "skip", reason: "suppressed" };
  }
  if (link !== null && link.threadId !== null && threadShell === null) {
    // The imported thread was deleted in Synara: tombstone the link so the
    // session is never recreated automatically.
    return { kind: "tombstone" };
  }
  if (link !== null && threadShell !== null) {
    if (threadShell.session !== null && BUSY_SESSION_STATUSES.has(threadShell.session.status)) {
      return { kind: "skip", reason: "busy" };
    }
    if (sessionRevision !== null && link.sourceRevision === sessionRevision) {
      return { kind: "skip", reason: "unchanged" };
    }
    return { kind: "incremental", projectId: threadShell.projectId };
  }
  if (matchedProjectId !== null) {
    return { kind: "import", projectId: matchedProjectId };
  }
  if (link === null) {
    // Recorded but unmatched: keeps the session visible as discovered without
    // attaching it to an unrelated project.
    return { kind: "inbox" };
  }
  return { kind: "skip", reason: "unmatched" };
};

const scanIntervalFor = (sourceId: string): number => {
  if (sourceId.startsWith("devin-cloud-")) {
    const jitter = 1 + (Math.random() * 2 - 1) * CLOUD_SCAN_JITTER;
    return CLOUD_SCAN_INTERVAL_MS * jitter;
  }
  return LOCAL_SCAN_INTERVAL_MS;
};

const isSyncableSource = (sourceId: string): boolean => !sourceId.startsWith(ATIF_PREFIX);

/**
 * Supervisor loop. Resolves the per-source schedule in-memory (discovery
 * watermarks and failure state persist on the source row; scan pacing itself
 * is process-local by design). Runs at most one scan per source at a time and
 * a single worker total — no renderer polling, so duplicate tabs cannot
 * double the worker count.
 */
export const makeExternalHistorySyncLoop = (options: ExternalHistorySyncOptions) =>
  Effect.gen(function* () {
    const { repository, projectionSnapshotQuery, serverSettings } = options;
    const service = makeExternalHistoryService({
      repository,
      orchestrationEngine: options.orchestrationEngine,
      homeDir: options.homeDir,
    });
    const nextDueAt = new Map<string, number>();
    const now = () => new Date().toISOString();

    const markSource = (
      sourceId: string,
      patch: { lastDiscoverySuccessAt?: string; lastErrorCode?: string | null },
    ) =>
      repository.getSource({ sourceId }).pipe(
        Effect.flatMap((record) =>
          Option.isSome(record)
            ? repository.upsertSource({
                ...record.value,
                ...(patch.lastDiscoverySuccessAt !== undefined
                  ? { lastDiscoverySuccessAt: patch.lastDiscoverySuccessAt }
                  : {}),
                lastErrorCode:
                  patch.lastErrorCode === undefined
                    ? record.value.lastErrorCode
                    : patch.lastErrorCode,
                updatedAt: now(),
              })
            : Effect.void,
        ),
        Effect.catch(() => Effect.void),
      );

    const scanSource = (sourceId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const listed = yield* service.listSessions({
          sourceId,
          limit: DISCOVERY_LIMIT,
        });
        const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
        const threadById = new Map(snapshot.threads.map((t) => [t.id as string, t]));

        for (const session of listed.sessions) {
          yield* syncSession(sourceId, session, threadById).pipe(
            Effect.catch((error) =>
              Effect.logWarning("external history sync failed for session", {
                sourceId,
                externalSessionId: session.externalSessionId,
                error,
              }),
            ),
          );
        }
        yield* markSource(sourceId, {
          lastDiscoverySuccessAt: now(),
          lastErrorCode: null,
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.andThen(
            markSource(sourceId, { lastErrorCode: "sync-scan-failed" }),
            Effect.logWarning("external history sync scan failed", { sourceId, error }),
          ),
        ),
      );

    const syncSession = (
      sourceId: string,
      session: ExternalHistorySessionDescriptor,
      threadById: ReadonlyMap<string, OrchestrationThreadShell>,
    ): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const linkOption = yield* repository.getLink({
          sourceId,
          externalSessionId: session.externalSessionId,
        });
        const link = Option.isSome(linkOption) ? linkOption.value : null;
        const threadShell =
          link !== null && link.threadId !== null
            ? (threadById.get(link.threadId as string) ?? null)
            : null;
        const matchedProject =
          session.workspaceHint !== undefined
            ? yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(session.workspaceHint)
            : Option.none();
        const plan = planExternalHistorySync({
          link,
          threadShell,
          matchedProjectId: Option.isSome(matchedProject) ? matchedProject.value.id : null,
          sessionRevision: session.originalUpdatedAt ?? null,
        });

        switch (plan.kind) {
          case "skip":
            return;
          case "tombstone": {
            if (link === null) return;
            yield* repository.upsertLink({
              ...link,
              historyStatus: "suppressed",
              suppressedAt: now(),
              updatedAt: now(),
            });
            return;
          }
          case "inbox": {
            yield* repository.upsertLink({
              linkId: `ehl-${crypto.randomUUID()}`,
              sourceId,
              externalSessionId: session.externalSessionId,
              threadId: null,
              sourceRevision: session.originalUpdatedAt ?? null,
              committedMessageCursor: null,
              historyStatus: "pending",
              nativeResumeDescriptor: null,
              upstreamMetadata: session as unknown as Schema.Json,
              userOverrideFlags: null,
              suppressedAt: null,
              createdAt: now(),
              updatedAt: now(),
            });
            return;
          }
          case "import": {
            yield* service.importHistory({
              sourceId,
              externalSessionId: session.externalSessionId,
              projectId: plan.projectId,
              modelSelection:
                session.model !== undefined
                  ? { provider: "devin", model: session.model }
                  : FALLBACK_MODEL_SELECTION,
            });
            return;
          }
          case "incremental": {
            const modelSelection =
              threadShell !== null ? threadShell.modelSelection : FALLBACK_MODEL_SELECTION;
            yield* service.importHistory({
              sourceId,
              externalSessionId: session.externalSessionId,
              projectId: plan.projectId,
              modelSelection,
            });
            return;
          }
        }
      });

    while (true) {
      const settings = yield* serverSettings.getSettings;
      if (settings.providers.devin.externalHistorySync === true) {
        const sources = yield* service
          .listSources()
          .pipe(Effect.catch(() => Effect.succeed({ sources: [] })));
        const current = Date.now();
        for (const source of sources.sources) {
          if (
            !source.enabled ||
            source.paused ||
            !isSyncableSource(source.sourceId) ||
            (nextDueAt.get(source.sourceId) ?? 0) > current
          ) {
            continue;
          }
          nextDueAt.set(source.sourceId, current + scanIntervalFor(source.sourceId));
          yield* scanSource(source.sourceId);
        }
      }
      yield* Effect.sleep(Duration.millis(WAKE_INTERVAL_MS));
    }
  });
