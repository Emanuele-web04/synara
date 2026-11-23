// FILE: providerHistory/externalHistoryService.ts
// Purpose: Coordinates external history sources: probes which Devin sources
// exist locally, lists sessions, reads normalized transcripts, and imports a
// session into a Synara thread as immutable, deterministically-commanded
// batches. Read-only towards every provider — imports never send prompts,
// wake workers, or start turns. Layer: Provider history import.
// Exports: makeExternalHistoryService, ExternalHistoryServiceOptions.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProviderHistoryError,
  ThreadId,
  type ExternalHistoryImportInput,
  type ExternalHistoryImportResult,
  type ExternalHistoryListSessionsInput,
  type ExternalHistoryListSessionsResult,
  type ExternalHistoryListSourcesResult,
  type ExternalHistoryMessage,
  type ExternalHistoryReadHistoryInput,
  type ExternalHistoryReadHistoryResult,
  type ExternalHistorySessionDescriptor,
  type ExternalHistorySourceDescriptor,
} from "@synara/contracts";
import { Effect, Schema } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine";
import type {
  ExternalHistoryRepositoryError,
  ExternalHistoryRepositoryShape,
} from "../persistence/Services/ExternalHistory";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import { readDevinAtifFile, type DevinAtifExport } from "./devinAtifHistory.ts";
import {
  listDevinCloudOrganizations,
  listDevinCloudSessions,
  readDevinCloudMessages,
  type DevinCloudClientOptions,
  type DevinCloudIdentityOptions,
} from "./devinCloudHistory.ts";
import {
  defaultDevinLocalStorePath,
  listDevinLocalSessions,
  readDevinLocalSession,
} from "./devinLocalHistory.ts";
import {
  normalizeAtifExport,
  normalizeCloudCatalog,
  normalizeCloudMessages,
  normalizeLocalSessionCatalog,
  normalizeLocalTranscript,
  type NormalizedTranscript,
} from "./devinHistoryNormalizer.ts";

const OPERATION = "ExternalHistoryService";
const PAGE_LIMIT = 200;
const MAX_MESSAGES_PER_BATCH = 100;
const MAX_BATCH_BYTES = 256 * 1024;

// Canonical source ids are deterministic so discovery, retry and dedup all
// agree on identity without consulting the persistence layer.
const LOCAL_SOURCE_ID = "devin-local";
const ATIF_SOURCE_ID = "devin-atif";
const cloudSourceId = (orgId: string) => `devin-cloud-${orgId}`;

export interface ExternalHistoryServiceOptions {
  readonly repository: ExternalHistoryRepositoryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly homeDir: string;
  /** Test overrides; production defaults derive from homeDir/OS conventions. */
  readonly devinStorePath?: string;
  readonly devinCredentialsPath?: string;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

function fail(
  code: ProviderHistoryError["code"],
  operation: string,
  detail: string,
  retryable: boolean,
  cause?: unknown,
): never {
  throw new ProviderHistoryError({ operation, code, detail, retryable, cause });
}

function toHistoryError(operation: string) {
  return (cause: unknown): ProviderHistoryError => {
    if (cause instanceof ProviderHistoryError) return cause;
    return new ProviderHistoryError({
      operation,
      code: "read-failed",
      detail: cause instanceof Error ? cause.message : String(cause),
      retryable: false,
      cause,
    });
  };
}

const promise = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: toHistoryError(operation) });

function defaultCredentialsPath(homeDir: string): string {
  return path.join(homeDir, ".local", "share", "devin", "credentials.toml");
}

interface DevinCredentials {
  readonly token: string;
  readonly apiUrl: string;
}

function parseDevinCredentialsToml(text: string): DevinCredentials | null {
  const read = (key: string): string | null => {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m").exec(text);
    return match?.[1] ?? null;
  };
  const token = read("windsurf_api_key");
  const apiUrl = read("devin_api_url") ?? "https://api.devin.ai";
  return token === null ? null : { token, apiUrl };
}

const FULL_CAPABILITIES = {
  canList: true,
  canReadHistory: true,
  canResumeNative: false,
  canSyncNew: true,
  canSyncChanges: true,
  canReadWhileBusy: true,
} as const;

export function makeExternalHistoryService(options: ExternalHistoryServiceOptions) {
  const storePath = options.devinStorePath ?? defaultDevinLocalStorePath();
  const credentialsPath = options.devinCredentialsPath ?? defaultCredentialsPath(options.homeDir);

  const readCredentials = Effect.fn(function* () {
    const text = yield* promise(OPERATION, () => fs.readFile(credentialsPath, "utf8")).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (text === null) return null;
    return parseDevinCredentialsToml(text);
  });

  const cloudIdentity = Effect.fn(function* () {
    const credentials = yield* readCredentials();
    if (credentials === null) {
      return null;
    }
    const identity: DevinCloudIdentityOptions = {
      apiUrl: credentials.apiUrl,
      token: credentials.token,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    };
    const page = yield* promise(OPERATION, () =>
      listDevinCloudOrganizations(identity, { first: 1 }),
    );
    const org = page.items[0];
    if (org === undefined) {
      return { identity, orgId: null };
    }
    return { identity, orgId: org.orgId };
  });

  const localSourceAvailable = Effect.fn(function* () {
    const ok = yield* promise(OPERATION, () =>
      fs
        .access(storePath)
        .then(() => true)
        .catch(() => false),
    );
    return ok;
  });

  const listSources = (): Effect.Effect<
    ExternalHistoryListSourcesResult,
    ProviderHistoryError | ExternalHistoryRepositoryError
  > =>
    Effect.gen(function* () {
      const sources: Array<ExternalHistorySourceDescriptor> = [];
      if (yield* localSourceAvailable()) {
        yield* options.repository.getOrCreateSource({
          sourceId: LOCAL_SOURCE_ID,
          kind: "devin-local",
          scopeIdentity: storePath,
          filters: null,
          decoderVersion: "sessions.db/v1",
          enabled: true,
          paused: false,
          credentialRef: null,
          scopeGeneration: 0,
          lastDiscoverySuccessAt: null,
          lastErrorCode: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        sources.push({
          sourceId: LOCAL_SOURCE_ID,
          kind: "devin-local",
          scopeIdentity: storePath,
          capabilities: FULL_CAPABILITIES,
          versionEvidence: "sessions.db",
          enabled: true,
          paused: false,
        });
      }
      const cloud = yield* cloudIdentity().pipe(
        Effect.catch((error) =>
          Effect.succeed({
            error: error instanceof ProviderHistoryError ? error.code : "read-failed",
          }),
        ),
      );
      if (cloud !== null && "identity" in cloud) {
        if (cloud.orgId !== null) {
          const sourceId = cloudSourceId(cloud.orgId);
          yield* options.repository.getOrCreateSource({
            sourceId,
            kind: "devin-cloud",
            scopeIdentity: `${cloud.identity.apiUrl}/${cloud.orgId}`,
            filters: null,
            decoderVersion: "v3",
            enabled: true,
            paused: false,
            credentialRef: "devin/credentials.toml#windsurf_api_key",
            scopeGeneration: 0,
            lastDiscoverySuccessAt: new Date().toISOString(),
            lastErrorCode: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          sources.push({
            sourceId,
            kind: "devin-cloud",
            scopeIdentity: `${cloud.identity.apiUrl}/${cloud.orgId}`,
            capabilities: FULL_CAPABILITIES,
            versionEvidence: "v3",
            enabled: true,
            paused: false,
          });
        }
      } else if (cloud !== null) {
        // Credentials exist but the probe failed: list the source disabled so
        // the dialog can show the exact blocker instead of hiding it.
        sources.push({
          sourceId: "devin-cloud",
          kind: "devin-cloud",
          scopeIdentity: "unresolved",
          capabilities: {
            ...FULL_CAPABILITIES,
            canList: false,
            canSyncNew: false,
            unsupportedReasons: {
              canList: `Cloud probe failed: ${cloud.error}`,
            },
          },
          enabled: false,
          paused: false,
          lastErrorCode: cloud.error,
        });
      }
      sources.push({
        sourceId: ATIF_SOURCE_ID,
        kind: "devin-atif",
        scopeIdentity: "export-file",
        capabilities: {
          canList: false,
          canReadHistory: true,
          canResumeNative: false,
          canSyncNew: false,
          canSyncChanges: false,
          canReadWhileBusy: true,
          unsupportedReasons: {
            canList: "An ATIF export file describes a single session.",
          },
        },
        enabled: true,
        paused: false,
      });
      return { sources };
    });

  const readFullTranscript = (
    sourceId: string,
    externalSessionId: string,
  ): Effect.Effect<
    {
      descriptor: ExternalHistorySessionDescriptor | null;
      transcript: NormalizedTranscript;
      sourceRevision: string | null;
    },
    ProviderHistoryError
  > =>
    Effect.gen(function* () {
      if (sourceId === LOCAL_SOURCE_ID) {
        const { session, messages } = yield* promise(OPERATION, () =>
          readDevinLocalSession({ dbPath: storePath, sessionId: externalSessionId }),
        );
        const descriptor =
          normalizeLocalSessionCatalog(sourceId, [
            {
              sessionId: session.sessionId,
              workingDirectory: session.workingDirectory,
              backendType: session.backendType,
              model: session.model,
              agentMode: session.agentMode,
              createdAt: session.createdAt,
              lastActivityAt: session.lastActivityAt,
              title: session.title,
              mainChainId: session.mainChainId,
              hidden: session.hidden,
              workspaceDirs: session.workspaceDirs,
            },
          ])[0] ?? null;
        return {
          descriptor,
          transcript: normalizeLocalTranscript(messages),
          sourceRevision: session.lastActivityAt,
        };
      }
      if (sourceId === ATIF_SOURCE_ID) {
        const atif: DevinAtifExport = yield* promise(OPERATION, () =>
          readDevinAtifFile(externalSessionId),
        );
        return {
          descriptor: {
            sourceId,
            externalSessionId,
            sourceOrigin: "devin-atif",
            title: path.basename(externalSessionId),
          },
          transcript: normalizeAtifExport(atif),
          sourceRevision: atif.schemaVersion,
        };
      }
      if (sourceId.startsWith("devin-cloud-")) {
        const cloud = yield* cloudIdentity();
        if (cloud === null || cloud.orgId === null) {
          fail("not-configured", OPERATION, "Devin Cloud credentials are not configured.", false);
        }
        const client: DevinCloudClientOptions = {
          ...cloud.identity,
          orgId: cloud.orgId,
        };
        const items: Array<import("./devinCloudHistory.ts").DevinCloudMessage> = [];
        let cursor: string | null = null;
        for (;;) {
          const page = yield* promise(OPERATION, () =>
            readDevinCloudMessages(client, {
              sessionId: externalSessionId,
              first: PAGE_LIMIT,
              after: cursor,
            }),
          );
          items.push(...page.items);
          if (!page.hasNextPage || page.endCursor === null) break;
          cursor = page.endCursor;
        }
        const sessionsPage = yield* promise(OPERATION, () =>
          listDevinCloudSessions(client, { first: PAGE_LIMIT }),
        );
        const descriptor = normalizeCloudCatalog(
          sourceId,
          sessionsPage.items.filter((s) => s.sessionId === externalSessionId),
        )[0] ?? {
          sourceId,
          externalSessionId,
          sourceOrigin: "devin-cloud",
        };
        const transcript = normalizeCloudMessages(items);
        return {
          descriptor,
          transcript,
          sourceRevision: items[items.length - 1]?.createdAt ?? null,
        };
      }
      return fail("not-found", OPERATION, `Unknown external history source: ${sourceId}`, false);
    });

  const listSessions = (
    input: ExternalHistoryListSessionsInput,
  ): Effect.Effect<ExternalHistoryListSessionsResult, ProviderHistoryError> =>
    Effect.gen(function* () {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), PAGE_LIMIT);
      const offset = input.cursor !== undefined ? Number(input.cursor) : 0;
      if (Number.isNaN(offset)) {
        fail("read-failed", OPERATION, "Invalid sessions cursor.", false);
      }
      if (input.sourceId === LOCAL_SOURCE_ID) {
        const rows = yield* promise(OPERATION, () => listDevinLocalSessions({ dbPath: storePath }));
        const all = normalizeLocalSessionCatalog(input.sourceId, rows);
        const pageItems = all.slice(offset, offset + limit);
        const nextOffset = offset + pageItems.length;
        return {
          sessions: pageItems,
          ...(nextOffset < all.length ? { nextCursor: String(nextOffset) } : {}),
          complete: nextOffset >= all.length,
        };
      }
      if (input.sourceId === ATIF_SOURCE_ID) {
        return fail(
          "unsupported-capability",
          OPERATION,
          "An ATIF export file describes a single session; pass its path to readHistory.",
          false,
        );
      }
      if (input.sourceId.startsWith("devin-cloud-")) {
        const cloud = yield* cloudIdentity();
        if (cloud === null || cloud.orgId === null) {
          fail("not-configured", OPERATION, "Devin Cloud credentials are not configured.", false);
        }
        const client: DevinCloudClientOptions = { ...cloud.identity, orgId: cloud.orgId };
        const page = yield* promise(OPERATION, () =>
          listDevinCloudSessions(client, {
            first: limit,
            after: input.cursor ?? null,
          }),
        );
        return {
          sessions: normalizeCloudCatalog(input.sourceId, page.items),
          ...(page.hasNextPage && page.endCursor !== null ? { nextCursor: page.endCursor } : {}),
          complete: !page.hasNextPage,
        };
      }
      return fail("not-found", OPERATION, `Unknown source: ${input.sourceId}`, false);
    });

  const readHistory = (
    input: ExternalHistoryReadHistoryInput,
  ): Effect.Effect<ExternalHistoryReadHistoryResult, ProviderHistoryError> =>
    Effect.gen(function* () {
      if (input.sourceId === LOCAL_SOURCE_ID || input.sourceId === ATIF_SOURCE_ID) {
        const { transcript, sourceRevision } = yield* readFullTranscript(
          input.sourceId,
          input.externalSessionId,
        );
        const offset = input.cursor !== undefined ? Number(input.cursor) : 0;
        if (Number.isNaN(offset)) {
          fail("read-failed", OPERATION, "Invalid history cursor.", false);
        }
        const pageItems = transcript.messages.slice(offset, offset + PAGE_LIMIT);
        const nextOffset = offset + pageItems.length;
        return {
          messages: pageItems,
          ...(nextOffset < transcript.messages.length ? { nextCursor: String(nextOffset) } : {}),
          ...(sourceRevision !== null ? { sourceRevision } : {}),
          complete: nextOffset >= transcript.messages.length,
        };
      }
      if (input.sourceId.startsWith("devin-cloud-")) {
        const cloud = yield* cloudIdentity();
        if (cloud === null || cloud.orgId === null) {
          fail("not-configured", OPERATION, "Devin Cloud credentials are not configured.", false);
        }
        const client: DevinCloudClientOptions = { ...cloud.identity, orgId: cloud.orgId };
        const page = yield* promise(OPERATION, () =>
          readDevinCloudMessages(client, {
            sessionId: input.externalSessionId,
            first: PAGE_LIMIT,
            after: input.cursor ?? null,
          }),
        );
        const transcript = normalizeCloudMessages(page.items);
        return {
          messages: transcript.messages,
          ...(page.hasNextPage && page.endCursor !== null ? { nextCursor: page.endCursor } : {}),
          complete: !page.hasNextPage,
        };
      }
      return fail("not-found", OPERATION, `Unknown source: ${input.sourceId}`, false);
    });

  /**
   * Deterministic, retry-safe synara message id for an upstream message: the
   * same upstream id always maps to the same local id across retries and
   * re-imports, which is what makes the append-only dedup crash-safe.
   */
  const synaraMessageId = (linkId: string, upstreamMessageId: string): MessageId =>
    MessageId.makeUnsafe(
      `eh-${crypto.createHash("sha256").update(`${linkId}:${upstreamMessageId}`).digest("hex").slice(0, 32)}`,
    );

  const importHistory = (
    input: ExternalHistoryImportInput,
  ): Effect.Effect<
    ExternalHistoryImportResult,
    ProviderHistoryError | ExternalHistoryRepositoryError | OrchestrationDispatchError
  > =>
    Effect.gen(function* () {
      const now = () => new Date().toISOString();
      // 1) Resolve the source so the link lands on the canonical sourceId even
      //    if the caller passed a descriptor-less id.
      const descriptor = input.sourceId;
      const {
        transcript,
        sourceRevision,
        descriptor: sessionDescriptor,
      } = yield* readFullTranscript(descriptor, input.externalSessionId);

      // 2) Link (dedup target): one canonical link per (sourceId, externalId).
      const existingLink = yield* options.repository.getLink({
        sourceId: descriptor,
        externalSessionId: input.externalSessionId,
      });
      const linkId =
        existingLink._tag === "Some" ? existingLink.value.linkId : `ehl-${crypto.randomUUID()}`;
      const link = {
        linkId,
        sourceId: descriptor,
        externalSessionId: input.externalSessionId,
        threadId: existingLink._tag === "Some" ? existingLink.value.threadId : null,
        sourceRevision,
        committedMessageCursor: null,
        historyStatus: "reading" as const,
        // Only the local CLI store row can be reloaded natively through ACP
        // `session/load`; Cloud and ATIF imports stay transcript-only and take
        // the bounded-context handoff path on first send.
        nativeResumeDescriptor:
          input.sourceId === LOCAL_SOURCE_ID
            ? ({
                kind: "devin-acp",
                sessionId: input.externalSessionId,
                ...(sessionDescriptor?.model !== undefined
                  ? { model: sessionDescriptor.model }
                  : {}),
              } as Schema.Json)
            : null,
        upstreamMetadata:
          sessionDescriptor !== null ? (sessionDescriptor as unknown as Schema.Json) : null,
        userOverrideFlags: null,
        suppressedAt: null,
        createdAt: existingLink._tag === "Some" ? existingLink.value.createdAt : now(),
        updatedAt: now(),
      };
      yield* options.repository.upsertLink(link);

      // 3) Already-staged upstream ids (re-import dedup).
      const staged = yield* options.repository.listMessagesByLink({ linkId });
      const stagedIds = new Set(staged.map((m) => m.upstreamMessageId));
      const fresh = transcript.messages.filter((m) => !stagedIds.has(m.upstreamMessageId));

      // 4) Persist message records (idempotent upsert with revision guard).
      yield* options.repository.upsertMessages(
        transcript.messages.map((m) => ({
          linkId,
          upstreamMessageId: m.upstreamMessageId,
          synaraMessageId: synaraMessageId(linkId, m.upstreamMessageId),
          sourceOrder: m.sourceOrder,
          contentHash: m.contentHash ?? null,
          sourceRevision: m.sourceRevision ?? null,
          originalTimestamp: m.originalTimestamp ?? null,
          visibility: "visible" as const,
          createdAt: now(),
          updatedAt: now(),
        })),
      );

      // 5) Create the target thread on first import, reuse on re-import.
      let threadId = link.threadId;
      if (threadId === null) {
        threadId = ThreadId.makeUnsafe(`eth-${crypto.randomUUID()}`);
        yield* options.orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`ext-hist-create-${linkId}`),
          threadId,
          projectId: input.projectId,
          title: input.title ?? sessionDescriptor?.title ?? "Devin session",
          modelSelection: input.modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          envMode: "local",
          branch: null,
          worktreePath: null,
          workingDirectory: sessionDescriptor?.workspaceHint ?? null,
          creationSource: "provider_native",
          createdAt: now(),
        });
      }

      // 6) Dispatch immutable import batches with deterministic commandIds —
      //    a crash mid-import replays the same batch ids and dedupes.
      const batches: Array<ReadonlyArray<ExternalHistoryMessage>> = [];
      let current: Array<ExternalHistoryMessage> = [];
      let currentBytes = 0;
      for (const message of fresh) {
        const size = Buffer.byteLength(message.text, "utf8") + 64;
        if (
          current.length > 0 &&
          (current.length >= MAX_MESSAGES_PER_BATCH || currentBytes + size > MAX_BATCH_BYTES)
        ) {
          batches.push(current);
          current = [];
          currentBytes = 0;
        }
        current.push(message);
        currentBytes += size;
      }
      if (current.length > 0) batches.push(current);

      const jobId = `ehj-${linkId}`;
      yield* options.repository.upsertJob({
        jobId,
        sourceId: descriptor,
        scopeGeneration: 0,
        scanUpperBound: null,
        status: "importing",
        counters: { total: transcript.messages.length },
        retries: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        pageCursor: null,
        checkpoint: null,
        createdAt: now(),
        updatedAt: now(),
      });

      for (const [index, batch] of batches.entries()) {
        const batchId = `ehb-${linkId}-${index}`;
        const payload = batch.map((m) => m.upstreamMessageId);
        yield* options.repository.insertBatch({
          batchId,
          jobId,
          linkId,
          payload: payload as unknown as Schema.Json,
          payloadHash: crypto.createHash("sha256").update(payload.join(",")).digest("hex"),
          commandId: `ext-hist-import-${batchId}`,
          state: "dispatched",
          acceptedSequence: null,
          nextCursor: null,
          createdAt: now(),
          updatedAt: now(),
        });
        yield* options.orchestrationEngine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe(`ext-hist-import-${batchId}`),
          threadId,
          messages: batch.map((m) => ({
            messageId: synaraMessageId(linkId, m.upstreamMessageId),
            role: m.role,
            text: m.text,
            createdAt: m.originalTimestamp ?? now(),
            updatedAt: m.originalTimestamp ?? now(),
          })),
          createdAt: now(),
        });
        yield* options.repository.updateBatchState({
          batchId,
          state: "accepted",
          acceptedSequence: index,
          nextCursor: null,
          updatedAt: now(),
        });
      }

      // 7) Close out: link complete, job complete.
      yield* options.repository.upsertLink({
        ...link,
        threadId,
        historyStatus: transcript.fidelity.includedCount > 0 ? "complete" : "partial",
        committedMessageCursor: String(transcript.messages.length),
        updatedAt: now(),
      });
      yield* options.repository.upsertJob({
        jobId,
        sourceId: descriptor,
        scopeGeneration: 0,
        scanUpperBound: null,
        status: "complete",
        counters: { total: transcript.messages.length, staged: staged.length },
        retries: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        pageCursor: null,
        checkpoint: null,
        createdAt: now(),
        updatedAt: now(),
      });

      return {
        linkId,
        threadId,
        alreadyStagedCount: staged.length,
        importedCount: fresh.length,
        fidelity: {
          readCount: transcript.fidelity.readCount,
          includedCount: transcript.fidelity.includedCount,
          droppedSystem: transcript.fidelity.dropped.system,
          droppedTool: transcript.fidelity.dropped.tool,
          droppedHiddenUser: transcript.fidelity.dropped.hiddenUser,
          droppedEmpty: transcript.fidelity.dropped.empty,
          droppedDuplicate: transcript.fidelity.dropped.duplicate,
        },
      };
    });

  return {
    listSources,
    listSessions,
    readHistory,
    importHistory,
  };
}
