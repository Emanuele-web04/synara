import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";

// FILE: ProviderRuntimeIngestion.types.ts
// Purpose: Shared types for provider runtime ingestion projection.
// Layer: Server orchestration ingestion
// Exports: TurnStartRequestedDomainEvent, RuntimeIngestionInput, ActivityPayload, SubagentIdentity

export type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

export type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

export type ActivityPayload = OrchestrationThreadActivity["payload"];

export interface SubagentIdentity {
  readonly providerThreadId: string;
  readonly agentId?: string;
  readonly nickname?: string;
  readonly role?: string;
  readonly model?: string;
  readonly modelIsRequestedHint?: boolean;
}
