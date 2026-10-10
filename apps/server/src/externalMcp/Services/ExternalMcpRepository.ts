import type {
  ExternalMcpCapability,
  ExternalMcpClientKind,
  ExternalMcpProjectScope,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { AgentGatewayOperationRecord } from "../../agentGateway/Services/AgentGatewayOperationRepository.ts";

export interface ExternalMcpIntegrationRecord {
  readonly integrationId: string;
  readonly name: string;
  readonly clientKind: ExternalMcpClientKind;
  readonly audience: "synara.external-mcp";
  readonly credentialHash: string | null;
  readonly capabilities: ReadonlyArray<ExternalMcpCapability>;
  readonly projectScope: ExternalMcpProjectScope;
  readonly projectIds: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly pairedAt: string | null;
  readonly revokedAt: string | null;
  readonly rateLimitPerMinute: number;
  readonly concurrencyLimit: number;
}

export interface ExternalMcpProjectRecord {
  readonly id: string;
  readonly title: string;
}

export interface ExternalMcpOperationRecord extends Omit<
  AgentGatewayOperationRecord,
  "callerThreadId" | "callerTurnId"
> {
  readonly integrationId: string;
}

export type ReserveExternalMcpOperationResult =
  | { readonly kind: "reserved"; readonly operation: ExternalMcpOperationRecord }
  | { readonly kind: "replay"; readonly operation: ExternalMcpOperationRecord }
  | { readonly kind: "idempotency_conflict"; readonly operation: ExternalMcpOperationRecord }
  | { readonly kind: "concurrency_limited"; readonly activeCount: number; readonly limit: number };

export interface ExternalMcpTaskRecord {
  readonly integrationId: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly status: "planned" | "created" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExternalMcpRepositoryShape {
  readonly listActiveProjects: () => Effect.Effect<ReadonlyArray<ExternalMcpProjectRecord>, Error>;
  readonly createIntegration: (input: {
    readonly integrationId: string;
    readonly name: string;
    readonly clientKind?: ExternalMcpClientKind;
    readonly audience: "synara.external-mcp";
    readonly capabilities: ReadonlyArray<ExternalMcpCapability>;
    readonly projectScope: ExternalMcpProjectScope;
    readonly projectIds: ReadonlyArray<string>;
    readonly pairingHash: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly pairingExpiresAt: string;
    readonly rateLimitPerMinute: number;
    readonly concurrencyLimit: number;
  }) => Effect.Effect<void, Error>;
  readonly listIntegrations: () => Effect.Effect<
    ReadonlyArray<ExternalMcpIntegrationRecord>,
    Error
  >;
  readonly getIntegrationById: (
    integrationId: string,
  ) => Effect.Effect<ExternalMcpIntegrationRecord | null, Error>;
  readonly getActiveIntegrationByCredentialHash: (input: {
    readonly credentialHash: string;
    readonly now: string;
  }) => Effect.Effect<ExternalMcpIntegrationRecord | null, Error>;
  readonly consumePairingCode: (input: {
    readonly pairingHash: string;
    readonly credentialHash: string;
    readonly now: string;
  }) => Effect.Effect<ExternalMcpIntegrationRecord | null, Error>;
  readonly refreshPairingCode: (input: {
    readonly integrationId: string;
    readonly pairingHash: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  }) => Effect.Effect<boolean, Error>;
  readonly revokeIntegration: (input: {
    readonly integrationId: string;
    readonly revokedAt: string;
  }) => Effect.Effect<boolean, Error>;
  readonly touchLastUsed: (input: {
    readonly integrationId: string;
    readonly usedAt: string;
  }) => Effect.Effect<void, Error>;
  readonly beginAudit: (input: {
    readonly auditId: string;
    readonly integrationId: string;
    readonly tool: string;
    readonly requestId: string | null;
    readonly projectId: string | null;
    readonly runtimeMode: string | null;
    readonly environment: string | null;
    readonly now: string;
    readonly windowId: number;
    readonly rateLimitAuditId: string;
    readonly retentionCutoff: string;
    readonly rateLimitPerMinute: number;
  }) => Effect.Effect<boolean, Error>;
  readonly finishAudit: (input: {
    readonly auditId: string;
    readonly outcome: string;
    readonly createdTaskIds: ReadonlyArray<string>;
    readonly detail?: string;
  }) => Effect.Effect<void, Error>;
  readonly reserveOperation: (input: {
    readonly operationId: string;
    readonly integrationId: string;
    readonly requestId: string;
    readonly fingerprint: string;
    readonly requestedCount: 1;
    readonly planJson: string;
    readonly now: string;
  }) => Effect.Effect<ReserveExternalMcpOperationResult, Error>;
  readonly markOperationDispatching: (input: {
    readonly operationId: string;
    readonly now: string;
  }) => Effect.Effect<boolean, Error>;
  readonly recordOperationWorktreeCreated: (input: {
    readonly operationId: string;
    readonly index: number;
    readonly workspaceRoot: string;
    readonly path: string;
    readonly branch: string | null;
    readonly token: string;
    readonly gitDir: string;
    readonly head: string;
    readonly stateHash?: string;
    readonly now: string;
  }) => Effect.Effect<boolean, Error>;
  readonly markOperationCompensating: (input: {
    readonly operationId: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly recordOperationCompensationFailure: (input: {
    readonly operationId: string;
    readonly errorJson: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly completeOperation: (input: {
    readonly operationId: string;
    readonly resultJson: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly failOperation: (input: {
    readonly operationId: string;
    readonly errorJson: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly failOperationAndTask: (input: {
    readonly operationId: string;
    readonly errorJson: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly getOperationById: (
    operationId: string,
  ) => Effect.Effect<ExternalMcpOperationRecord | null, Error>;
  readonly getOperationByRequest: (input: {
    readonly integrationId: string;
    readonly requestId: string;
  }) => Effect.Effect<ExternalMcpOperationRecord | null, Error>;
  readonly listNonTerminalOperations: () => Effect.Effect<
    ReadonlyArray<ExternalMcpOperationRecord>,
    Error
  >;
  readonly registerTask: (input: {
    readonly integrationId: string;
    readonly operationId: string;
    readonly requestId: string;
    readonly threadId: string;
    readonly projectId: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly markTaskStatus: (input: {
    readonly operationId: string;
    readonly status: ExternalMcpTaskRecord["status"];
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly getTask: (input: {
    readonly integrationId: string;
    readonly threadId: string;
  }) => Effect.Effect<ExternalMcpTaskRecord | null, Error>;
}

export class ExternalMcpRepository extends ServiceMap.Service<
  ExternalMcpRepository,
  ExternalMcpRepositoryShape
>()("synara/externalMcp/Services/ExternalMcpRepository") {}
