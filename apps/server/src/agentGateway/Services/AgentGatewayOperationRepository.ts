import { ServiceMap } from "effect";
import type { Effect } from "effect";

export type AgentGatewayOperationStatus =
  | "reserved"
  | "dispatching"
  | "completed"
  | "failed"
  | "compensating";

export interface AgentGatewayOperationRecord {
  readonly operationId: string;
  readonly callerThreadId: string;
  readonly callerTurnId: string;
  readonly operationKind: "create_threads";
  readonly requestId: string;
  readonly fingerprint: string;
  readonly requestedCount: number;
  readonly planJson: string;
  readonly status: AgentGatewayOperationStatus;
  readonly resultJson: string | null;
  readonly errorJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ReserveAgentGatewayOperationResult =
  | { readonly kind: "reserved"; readonly operation: AgentGatewayOperationRecord }
  | { readonly kind: "replay"; readonly operation: AgentGatewayOperationRecord }
  | { readonly kind: "idempotency_conflict"; readonly operation: AgentGatewayOperationRecord }
  | { readonly kind: "creation_plan_locked"; readonly operation: AgentGatewayOperationRecord };

export interface ReserveAgentGatewayOperationInput {
  readonly operationId: string;
  readonly callerThreadId: string;
  readonly callerTurnId: string;
  readonly operationKind: "create_threads";
  readonly requestId: string;
  readonly fingerprint: string;
  readonly requestedCount: number;
  readonly planJson: string;
  readonly now: string;
}

export interface AgentGatewayOperationRepositoryShape {
  readonly reserve: (
    input: ReserveAgentGatewayOperationInput,
  ) => Effect.Effect<ReserveAgentGatewayOperationResult, Error>;
  readonly markDispatching: (input: {
    readonly operationId: string;
    readonly now: string;
  }) => Effect.Effect<boolean, Error>;
  readonly markCompensating: (input: {
    readonly operationId: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly complete: (input: {
    readonly operationId: string;
    readonly resultJson: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly fail: (input: {
    readonly operationId: string;
    readonly errorJson: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly getById: (
    operationId: string,
  ) => Effect.Effect<AgentGatewayOperationRecord | null, Error>;
  readonly getByScope: (input: {
    readonly callerThreadId: string;
    readonly callerTurnId: string;
    readonly operationKind: "create_threads";
  }) => Effect.Effect<AgentGatewayOperationRecord | null, Error>;
  readonly listNonTerminal: () => Effect.Effect<ReadonlyArray<AgentGatewayOperationRecord>, Error>;
}

export class AgentGatewayOperationRepository extends ServiceMap.Service<
  AgentGatewayOperationRepository,
  AgentGatewayOperationRepositoryShape
>()("synara/agentGateway/Services/AgentGatewayOperationRepository") {}
