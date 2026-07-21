import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  EXTERNAL_MCP_AUDIENCE,
  ProjectId,
  type ExternalMcpCapability,
  type ExternalMcpCreateIntegrationResult,
  type ExternalMcpIntegration,
  type ExternalMcpPairResult,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ExternalMcpRepository } from "../Services/ExternalMcpRepository.ts";
import {
  ExternalMcpError,
  ExternalMcpService,
  type ExternalMcpServiceShape,
  type ExternalMcpVerifiedClient,
} from "../Services/ExternalMcpService.ts";
import type { ExternalMcpIntegrationRecord } from "../Services/ExternalMcpRepository.ts";
import { externalMcpLauncher, externalMcpShellCommand } from "../launcher.ts";

const DEFAULT_EXPIRY_DAYS = 30;
const PAIRING_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
const DEFAULT_ACTIVE_TASK_LIMIT = 2;
const CREDENTIAL_PREFIX = "syn_mcp_v1_";
const PAIRING_PREFIX = "syn_pair_v1_";
const AUDIT_RETENTION_MS = 30 * 86_400_000;

export function hashExternalMcpSecret(secret: string): string {
  return createHash("sha256")
    .update(EXTERNAL_MCP_AUDIENCE)
    .update("\0")
    .update(secret)
    .digest("hex");
}

function randomOpaque(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function toVerified(integration: ExternalMcpIntegrationRecord): ExternalMcpVerifiedClient {
  return {
    integration,
    capabilities: new Set(integration.capabilities),
    allowedProjectIds: new Set(integration.projectIds),
  };
}

function toExternalMcpError(
  code: string,
  message: string,
  status: NonNullable<ExternalMcpError["status"]>,
  cause?: unknown,
) {
  return new ExternalMcpError({ code, message, status, ...(cause === undefined ? {} : { cause }) });
}

export const makeExternalMcpService = Effect.gen(function* () {
  const repository = yield* ExternalMcpRepository;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const config = yield* ServerConfig;

  const loadProjectsById = () =>
    snapshotQuery.getShellSnapshot().pipe(
      Effect.map((snapshot) => new Map(snapshot.projects.map((project) => [project.id, project]))),
      Effect.mapError((cause) =>
        toExternalMcpError("repository_error", "Could not load Synara projects.", 500, cause),
      ),
    );

  const toView = (
    record: ExternalMcpIntegrationRecord,
    projectsById: ReadonlyMap<string, { readonly id: string; readonly title: string }>,
  ): ExternalMcpIntegration => ({
    integrationId: record.integrationId,
    name: record.name,
    audience: record.audience,
    capabilities: [...record.capabilities],
    allowedProjects: record.projectIds.flatMap((projectId) => {
      const project = projectsById.get(projectId);
      return project ? [{ projectId: ProjectId.makeUnsafe(project.id), title: project.title }] : [];
    }),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    pairedAt: record.pairedAt,
    revokedAt: record.revokedAt,
    rateLimitPerMinute: record.rateLimitPerMinute,
    concurrencyLimit: record.concurrencyLimit,
    clientKind: record.clientKind,
    stdio: externalMcpLauncher([
      "mcp",
      "serve",
      "--integration",
      record.integrationId,
      "--home-dir",
      config.baseDir,
    ]),
  });

  const makeSetup = (
    record: ExternalMcpIntegrationRecord,
    projectsById: ReadonlyMap<string, { readonly id: string; readonly title: string }>,
    pairingCode: string,
    pairingExpiresAt: string,
  ): ExternalMcpCreateIntegrationResult => {
    const stdio = externalMcpLauncher([
      "mcp",
      "serve",
      "--integration",
      record.integrationId,
      "--home-dir",
      config.baseDir,
    ]);
    const pair = externalMcpLauncher([
      "mcp",
      "pair",
      "--code",
      pairingCode,
      "--home-dir",
      config.baseDir,
    ]);
    return {
      integration: { ...toView(record, projectsById), stdio },
      pairingCode,
      pairingExpiresAt,
      setupCommand: externalMcpShellCommand(pair),
      stdio,
    };
  };

  const createIntegration: ExternalMcpServiceShape["createIntegration"] = (input) =>
    Effect.gen(function* () {
      const projectIds = [...new Set(input.projectIds)];
      const capabilities = [...new Set(input.capabilities)] as ReadonlyArray<ExternalMcpCapability>;
      const projectsById = yield* loadProjectsById();
      const missingProject = projectIds.find((projectId) => !projectsById.has(projectId));
      if (missingProject) {
        return yield* toExternalMcpError(
          "project_not_found",
          `Project "${missingProject}" was not found.`,
          400,
        );
      }
      if (capabilities.includes("tasks:create") && !capabilities.includes("projects:read")) {
        return yield* toExternalMcpError(
          "invalid_scope",
          'The "tasks:create" capability requires "projects:read".',
          400,
        );
      }
      const now = new Date();
      const createdAt = now.toISOString();
      const expiresAt = new Date(
        now.getTime() + (input.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 86_400_000,
      ).toISOString();
      const pairingExpiresAt = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();
      const integrationId = `mcp_int_${randomUUID()}`;
      const pairingCode = randomOpaque(PAIRING_PREFIX);
      yield* repository
        .createIntegration({
          integrationId,
          name: input.name,
          clientKind: input.clientKind ?? "other",
          audience: EXTERNAL_MCP_AUDIENCE,
          capabilities,
          projectIds,
          pairingHash: hashExternalMcpSecret(pairingCode),
          createdAt,
          expiresAt,
          pairingExpiresAt,
          rateLimitPerMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
          concurrencyLimit: DEFAULT_ACTIVE_TASK_LIMIT,
        })
        .pipe(
          Effect.mapError((cause) =>
            toExternalMcpError(
              "repository_error",
              "Could not create the external MCP integration.",
              500,
              cause,
            ),
          ),
        );
      const record = yield* repository.getIntegrationById(integrationId).pipe(
        Effect.mapError((cause) =>
          toExternalMcpError("repository_error", "Could not read the new integration.", 500, cause),
        ),
        Effect.flatMap((record) =>
          record
            ? Effect.succeed(record)
            : Effect.fail(
                toExternalMcpError(
                  "repository_error",
                  "The new integration could not be read back.",
                  500,
                ),
              ),
        ),
      );
      return makeSetup(record, projectsById, pairingCode, pairingExpiresAt);
    });

  const listIntegrations: ExternalMcpServiceShape["listIntegrations"] = () =>
    Effect.all([repository.listIntegrations(), loadProjectsById()]).pipe(
      Effect.map(([records, projectsById]) =>
        records.map((record) => toView(record, projectsById)),
      ),
      Effect.mapError((cause) =>
        cause instanceof ExternalMcpError
          ? cause
          : toExternalMcpError(
              "repository_error",
              "Could not list external MCP integrations.",
              500,
              cause,
            ),
      ),
    );

  const revokeIntegration: ExternalMcpServiceShape["revokeIntegration"] = (integrationId) =>
    repository
      .revokeIntegration({ integrationId, revokedAt: new Date().toISOString() })
      .pipe(
        Effect.mapError((cause) =>
          toExternalMcpError(
            "repository_error",
            "Could not revoke the external MCP integration.",
            500,
            cause,
          ),
        ),
      );

  const refreshPairing: ExternalMcpServiceShape["refreshPairing"] = ({ integrationId }) =>
    Effect.gen(function* () {
      const record = yield* repository
        .getIntegrationById(integrationId)
        .pipe(
          Effect.mapError((cause) =>
            toExternalMcpError("repository_error", "Could not read the integration.", 500, cause),
          ),
        );
      if (
        !record ||
        record.revokedAt !== null ||
        record.credentialHash !== null ||
        record.expiresAt <= new Date().toISOString()
      ) {
        return yield* toExternalMcpError(
          "pairing_unavailable",
          "Only an active, not-yet-paired integration can receive a new pairing code.",
          409,
        );
      }
      const now = new Date();
      const pairingCode = randomOpaque(PAIRING_PREFIX);
      const pairingExpiresAt = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();
      const refreshed = yield* repository
        .refreshPairingCode({
          integrationId,
          pairingHash: hashExternalMcpSecret(pairingCode),
          createdAt: now.toISOString(),
          expiresAt: pairingExpiresAt,
        })
        .pipe(
          Effect.mapError((cause) =>
            toExternalMcpError("repository_error", "Could not refresh pairing.", 500, cause),
          ),
        );
      if (!refreshed) {
        return yield* toExternalMcpError(
          "pairing_unavailable",
          "The integration was paired, revoked, or expired before pairing could be refreshed.",
          409,
        );
      }
      return makeSetup(record, yield* loadProjectsById(), pairingCode, pairingExpiresAt);
    });

  const pair: ExternalMcpServiceShape["pair"] = (pairingCode, credential) =>
    Effect.gen(function* () {
      if (!pairingCode.startsWith(PAIRING_PREFIX) || !credential.startsWith(CREDENTIAL_PREFIX)) {
        return yield* toExternalMcpError(
          "pairing_invalid",
          "The external MCP pairing code is invalid or expired.",
          401,
        );
      }
      const now = new Date().toISOString();
      const record = yield* repository
        .consumePairingCode({
          pairingHash: hashExternalMcpSecret(pairingCode),
          credentialHash: hashExternalMcpSecret(credential),
          now,
        })
        .pipe(
          Effect.mapError((cause) =>
            toExternalMcpError(
              "repository_error",
              "Could not complete external MCP pairing.",
              500,
              cause,
            ),
          ),
        );
      if (!record || record.credentialHash !== hashExternalMcpSecret(credential)) {
        return yield* toExternalMcpError(
          "pairing_invalid",
          "The external MCP pairing code is invalid or expired.",
          401,
        );
      }
      return {
        integrationId: record.integrationId,
        name: record.name,
        credential,
        expiresAt: record.expiresAt,
      } satisfies ExternalMcpPairResult;
    });

  const verifyCredential: ExternalMcpServiceShape["verifyCredential"] = (credential) =>
    Effect.gen(function* () {
      if (!credential.startsWith(CREDENTIAL_PREFIX)) {
        return yield* toExternalMcpError(
          "external_credential_invalid",
          "Missing, expired, revoked, or invalid external MCP credential.",
          401,
        );
      }
      const now = new Date().toISOString();
      const integration = yield* repository
        .getActiveIntegrationByCredentialHash({
          credentialHash: hashExternalMcpSecret(credential),
          now,
        })
        .pipe(
          Effect.mapError((cause) =>
            toExternalMcpError(
              "repository_error",
              "Could not validate the external MCP credential.",
              500,
              cause,
            ),
          ),
        );
      if (!integration || integration.audience !== EXTERNAL_MCP_AUDIENCE) {
        return yield* toExternalMcpError(
          "external_credential_invalid",
          "Missing, expired, revoked, or invalid external MCP credential.",
          401,
        );
      }
      yield* repository
        .touchLastUsed({ integrationId: integration.integrationId, usedAt: now })
        .pipe(
          Effect.mapError((cause) =>
            toExternalMcpError(
              "repository_error",
              "Could not update integration usage.",
              500,
              cause,
            ),
          ),
        );
      return toVerified(integration);
    });

  const assertActive: ExternalMcpServiceShape["assertActive"] = (integrationId) =>
    repository.getIntegrationById(integrationId).pipe(
      Effect.mapError((cause) =>
        toExternalMcpError("repository_error", "Could not validate integration state.", 500, cause),
      ),
      Effect.flatMap((integration) => {
        const active =
          integration &&
          integration.audience === EXTERNAL_MCP_AUDIENCE &&
          integration.credentialHash !== null &&
          integration.revokedAt === null &&
          integration.expiresAt > new Date().toISOString();
        return active
          ? Effect.succeed(toVerified(integration))
          : Effect.fail(
              toExternalMcpError(
                "external_credential_inactive",
                "The external MCP integration was revoked or expired.",
                401,
              ),
            );
      }),
    );

  const assertProject: ExternalMcpServiceShape["assertProject"] = (client, projectId) =>
    client.allowedProjectIds.has(projectId)
      ? Effect.void
      : Effect.fail(
          toExternalMcpError(
            "project_denied",
            `This integration is not authorized for project "${projectId}".`,
            403,
          ),
        );

  const assertTaskRead: ExternalMcpServiceShape["assertTaskRead"] = (client, threadId) =>
    repository.getTask({ integrationId: client.integration.integrationId, threadId }).pipe(
      Effect.mapError((cause) =>
        toExternalMcpError("repository_error", "Could not verify task ownership.", 500, cause),
      ),
      Effect.flatMap((task) => {
        // Ownership does not disappear merely because compensation marked the
        // durable task failed. If cleanup is incomplete, the issuing integration
        // must retain read/wait authority over its stranded thread.
        if (task !== null) return Effect.void;
        if (client.capabilities.has("tasks:read-project")) {
          return snapshotQuery.getThreadShellById(ThreadId.makeUnsafe(threadId)).pipe(
            Effect.mapError((cause) =>
              toExternalMcpError(
                "repository_error",
                "Could not verify the task project.",
                500,
                cause,
              ),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    toExternalMcpError("task_not_found", `Task "${threadId}" was not found.`, 404),
                  ),
                onSome: (thread) =>
                  client.allowedProjectIds.has(thread.projectId)
                    ? Effect.void
                    : Effect.fail(
                        toExternalMcpError(
                          "task_denied",
                          `This integration is not authorized to read task "${threadId}".`,
                          403,
                        ),
                      ),
              }),
            ),
          );
        }
        return Effect.fail(
          toExternalMcpError(
            "task_denied",
            `This integration is not authorized to read task "${threadId}".`,
            403,
          ),
        );
      }),
    );

  const beginAudit: ExternalMcpServiceShape["beginAudit"] = (client, metadata) =>
    Effect.gen(function* () {
      yield* assertActive(client.integration.integrationId);
      const auditId = `mcp_audit_${randomUUID()}`;
      const nowDate = new Date();
      const windowId = Math.floor(nowDate.getTime() / 60_000);
      const admitted = yield* repository
        .beginAudit({
          auditId,
          integrationId: client.integration.integrationId,
          tool: metadata.tool,
          requestId: metadata.requestId ?? null,
          projectId: metadata.projectId ?? null,
          runtimeMode: metadata.runtimeMode ?? null,
          environment: metadata.environment ?? null,
          now: nowDate.toISOString(),
          windowId,
          rateLimitAuditId: `mcp_rate_${client.integration.integrationId}_${windowId}`,
          retentionCutoff: new Date(nowDate.getTime() - AUDIT_RETENTION_MS).toISOString(),
          rateLimitPerMinute: client.integration.rateLimitPerMinute,
        })
        .pipe(
          Effect.mapError((cause) =>
            toExternalMcpError(
              "repository_error",
              "Could not record MCP audit metadata.",
              500,
              cause,
            ),
          ),
        );
      if (!admitted) {
        return yield* toExternalMcpError(
          "rate_limited",
          `This integration exceeded its ${client.integration.rateLimitPerMinute}-call per-minute limit.`,
          429,
        );
      }
      return auditId;
    });

  const finishAudit: ExternalMcpServiceShape["finishAudit"] = (input) =>
    repository
      .finishAudit({
        auditId: input.auditId,
        outcome: input.outcome,
        createdTaskIds: input.createdTaskIds ?? [],
        ...(input.detail ? { detail: input.detail.slice(0, 500) } : {}),
      })
      .pipe(
        Effect.mapError((cause) =>
          toExternalMcpError(
            "repository_error",
            "Could not finish external MCP audit row.",
            500,
            cause,
          ),
        ),
      );

  return {
    createIntegration,
    listIntegrations,
    revokeIntegration,
    refreshPairing,
    pair,
    verifyCredential,
    assertActive,
    assertProject,
    assertTaskRead,
    beginAudit,
    finishAudit,
  } satisfies ExternalMcpServiceShape;
});

export const ExternalMcpServiceLive = Layer.effect(ExternalMcpService, makeExternalMcpService);
