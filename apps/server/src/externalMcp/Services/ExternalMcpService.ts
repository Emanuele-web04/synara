import type {
  ExternalMcpCreateIntegrationInput,
  ExternalMcpCreateIntegrationResult,
  ExternalMcpIntegration,
  ExternalMcpPairResult,
  ExternalMcpRefreshPairingInput,
} from "@synara/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ExternalMcpIntegrationRecord } from "./ExternalMcpRepository.ts";

export class ExternalMcpError extends Data.TaggedError("ExternalMcpError")<{
  readonly code: string;
  readonly message: string;
  readonly status?: 400 | 401 | 403 | 404 | 409 | 429 | 500;
  readonly cause?: unknown;
}> {}

export interface ExternalMcpVerifiedClient {
  readonly integration: ExternalMcpIntegrationRecord;
  readonly capabilities: ReadonlySet<ExternalMcpIntegrationRecord["capabilities"][number]>;
  readonly allowedProjectIds: ReadonlySet<string>;
}

export interface ExternalMcpAuditMetadata {
  readonly tool: string;
  readonly requestId?: string | null;
  readonly projectId?: string | null;
  readonly runtimeMode?: string | null;
  readonly environment?: string | null;
}

export interface ExternalMcpServiceShape {
  readonly createIntegration: (
    input: ExternalMcpCreateIntegrationInput,
  ) => Effect.Effect<ExternalMcpCreateIntegrationResult, ExternalMcpError>;
  readonly listIntegrations: () => Effect.Effect<
    ReadonlyArray<ExternalMcpIntegration>,
    ExternalMcpError
  >;
  readonly revokeIntegration: (integrationId: string) => Effect.Effect<boolean, ExternalMcpError>;
  readonly refreshPairing: (
    input: ExternalMcpRefreshPairingInput,
  ) => Effect.Effect<ExternalMcpCreateIntegrationResult, ExternalMcpError>;
  readonly pair: (
    pairingCode: string,
    credential: string,
  ) => Effect.Effect<ExternalMcpPairResult, ExternalMcpError>;
  readonly verifyCredential: (
    credential: string,
  ) => Effect.Effect<ExternalMcpVerifiedClient, ExternalMcpError>;
  readonly assertActive: (integrationId: string) => Effect.Effect<void, ExternalMcpError>;
  readonly assertProject: (
    client: ExternalMcpVerifiedClient,
    projectId: string,
  ) => Effect.Effect<void, ExternalMcpError>;
  readonly assertTaskRead: (
    client: ExternalMcpVerifiedClient,
    threadId: string,
  ) => Effect.Effect<void, ExternalMcpError>;
  readonly beginAudit: (
    client: ExternalMcpVerifiedClient,
    metadata: ExternalMcpAuditMetadata,
  ) => Effect.Effect<string, ExternalMcpError>;
  readonly finishAudit: (input: {
    readonly auditId: string;
    readonly outcome: string;
    readonly createdTaskIds?: ReadonlyArray<string>;
    readonly detail?: string;
  }) => Effect.Effect<void, ExternalMcpError>;
}

export class ExternalMcpService extends ServiceMap.Service<
  ExternalMcpService,
  ExternalMcpServiceShape
>()("synara/externalMcp/Services/ExternalMcpService") {}
