import type { CompletionRepository } from "../completionRepository.ts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

// One durable thread-creation operation. Both `agent_gateway_operations` (Synara MCP) and
// `external_mcp_operations` (external MCP clients) store this machine.
//
//   reserved ─markDispatching (CAS: elects the single dispatcher)─> dispatching
//   dispatching ─complete─> completed
//   reserved | dispatching ─markCompensating─> compensating ─fail─> failed
//   reserved ─fail (startup recovery: nothing was touched)─> failed
//
// `completed` and `failed` are terminal. Only `markDispatching` (both repositories),
// agent `markCompensating`/`recordCompensationFailure`, and external `completeOperation`
// guard their source status in SQL; the other writes rely on `markDispatching` having
// elected one writer per operation (or on startup recovery running before any live
// claim). The lifecycle matrices in `AgentGatewayOperationRepository.test.ts` and
// `ExternalMcpRepository.test.ts` pin both the guards and the unguarded writes.
export type AgentGatewayOperationStatus =
  | "reserved"
  | "dispatching"
  | "completed"
  | "failed"
  | "compensating";

/** Every status an operation may move to from the keyed status. */
export const AGENT_GATEWAY_OPERATION_TRANSITIONS = {
  reserved: ["dispatching", "compensating", "failed"],
  dispatching: ["completed", "compensating", "failed"],
  compensating: ["failed"],
  completed: [],
  failed: [],
} as const satisfies Record<
  AgentGatewayOperationStatus,
  ReadonlyArray<AgentGatewayOperationStatus>
>;

export function canTransitionAgentGatewayOperation(
  from: AgentGatewayOperationStatus,
  to: AgentGatewayOperationStatus,
): boolean {
  return (
    AGENT_GATEWAY_OPERATION_TRANSITIONS[from] as ReadonlyArray<AgentGatewayOperationStatus>
  ).includes(to);
}

/** The operation is settled: replays return its result or error instead of waiting. */
export function isTerminalAgentGatewayOperationStatus(
  status: AgentGatewayOperationStatus,
): boolean {
  return AGENT_GATEWAY_OPERATION_TRANSITIONS[status].length === 0;
}

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
  | { readonly kind: "creation_plan_locked"; readonly operation: AgentGatewayOperationRecord }
  | { readonly kind: "turn_creation_limit"; readonly usedCount: number; readonly limit: number };

export interface ReserveAgentGatewayOperationInput {
  readonly operationId: string;
  readonly callerThreadId: string;
  readonly callerTurnId: string;
  readonly operationKind: "create_threads";
  readonly requestId: string;
  readonly fingerprint: string;
  readonly requestedCount: number;
  readonly allowAdditionalPlans?: boolean;
  readonly resumeContextJson?: string;
  readonly planJson: string;
  readonly now: string;
}

export interface AgentGatewayOperationRepositoryShape {
  readonly completions: CompletionRepository;
  readonly reserve: (
    input: ReserveAgentGatewayOperationInput,
  ) => Effect.Effect<ReserveAgentGatewayOperationResult, Error>;
  readonly markDispatching: (input: {
    readonly operationId: string;
    readonly now: string;
  }) => Effect.Effect<boolean, Error>;
  readonly recordWorktreeCreated: (input: {
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
  readonly markCompensating: (input: {
    readonly operationId: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly recordCompensationFailure: (input: {
    readonly operationId: string;
    readonly errorJson: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  /** Persist required creation metadata and the replay result in one transaction. */
  readonly complete: (
    input: { readonly operationId: string; readonly resultJson: string; readonly now: string },
    beforeCommit?: Effect.Effect<void, Error>,
  ) => Effect.Effect<void, Error>;
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
    readonly requestId?: string;
  }) => Effect.Effect<AgentGatewayOperationRecord | null, Error>;
  readonly listNonTerminal: () => Effect.Effect<ReadonlyArray<AgentGatewayOperationRecord>, Error>;
}

export class AgentGatewayOperationRepository extends ServiceMap.Service<
  AgentGatewayOperationRepository,
  AgentGatewayOperationRepositoryShape
>()("synara/agentGateway/Services/AgentGatewayOperationRepository") {}
