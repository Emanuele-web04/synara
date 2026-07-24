import {
  AutomationCancelRunInput,
  AutomationCancelRunResult,
  AutomationArchiveRunInput,
  AutomationCreateInput,
  AutomationDefinition,
  AutomationDeleteInput,
  AutomationListInput,
  AutomationListResult,
  AutomationMarkRunReadInput,
  AutomationMemory,
  AutomationResolveProposalInput,
  AutomationResolveProposalResult,
  AutomationRun,
  AutomationRunActionResult,
  AutomationRunNowInput,
  AutomationRunNowResult,
  AutomationStreamEvent,
  AutomationUpdateInput,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { AutomationServiceError } from "../Errors.ts";

export interface AutomationServiceShape {
  readonly list: (
    input?: AutomationListInput,
  ) => Effect.Effect<AutomationListResult, AutomationServiceError>;
  readonly create: (
    input: AutomationCreateInput,
  ) => Effect.Effect<AutomationDefinition, AutomationServiceError>;
  readonly update: (
    input: AutomationUpdateInput,
  ) => Effect.Effect<AutomationDefinition, AutomationServiceError>;
  readonly delete: (input: AutomationDeleteInput) => Effect.Effect<void, AutomationServiceError>;
  readonly resolveProposal: (
    input: AutomationResolveProposalInput,
  ) => Effect.Effect<AutomationResolveProposalResult, AutomationServiceError>;
  readonly getMemory: (
    automationId: AutomationDefinition["id"],
  ) => Effect.Effect<AutomationMemory | null, AutomationServiceError>;
  readonly listRunsForDefinition: (input: {
    readonly automationId: AutomationDefinition["id"];
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationServiceError>;
  readonly updateMemory: (input: {
    /** null resolves to the automation that dispatched the caller's active turn. */
    readonly automationId: AutomationDefinition["id"] | null;
    readonly content: string;
    readonly callerThreadId: ThreadId;
    readonly callerTurnId: TurnId | null;
  }) => Effect.Effect<AutomationMemory, AutomationServiceError>;
  readonly reportResult: (input: {
    readonly callerThreadId: ThreadId;
    readonly callerTurnId: TurnId | null;
    readonly decision: "notify" | "silent";
    readonly title?: string;
    readonly summary?: string;
  }) => Effect.Effect<AutomationRun, AutomationServiceError>;
  readonly runNow: (
    input: AutomationRunNowInput,
  ) => Effect.Effect<AutomationRunNowResult, AutomationServiceError>;
  readonly cancelRun: (
    input: AutomationCancelRunInput,
  ) => Effect.Effect<AutomationCancelRunResult, AutomationServiceError>;
  readonly markRunRead: (
    input: AutomationMarkRunReadInput,
  ) => Effect.Effect<AutomationRunActionResult, AutomationServiceError>;
  readonly archiveRun: (
    input: AutomationArchiveRunInput,
  ) => Effect.Effect<AutomationRunActionResult, AutomationServiceError>;
  readonly runDueOnce: (input?: {
    readonly now?: string;
    readonly limit?: number;
    readonly leaseOwnerId?: string;
  }) => Effect.Effect<ReadonlyArray<AutomationRunNowResult>, AutomationServiceError>;
  /**
   * Reconcile a single automation-owned thread's latest turn outcome into its run
   * (succeeded / failed / interrupted / waiting-for-approval). Safe to call repeatedly.
   */
  readonly reconcileThread: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, AutomationServiceError>;
  /** Reconcile every in-flight run against its thread state (scheduler backstop). */
  readonly reconcileActiveRuns: () => Effect.Effect<void, AutomationServiceError>;
  /** Recover runs orphaned by a crash/restart, closing or re-reconciling them. */
  readonly recoverPendingRuns: () => Effect.Effect<void, AutomationServiceError>;
  readonly streamEvents: Stream.Stream<AutomationStreamEvent, never, never>;
}

export class AutomationService extends ServiceMap.Service<
  AutomationService,
  AutomationServiceShape
>()("synara/automation/Services/AutomationService") {}
