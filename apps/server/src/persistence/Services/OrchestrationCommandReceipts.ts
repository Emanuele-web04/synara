/**
 * OrchestrationCommandReceiptRepository - Repository interface for command receipts.
 *
 * Owns persistence operations for deduplication and status tracking of
 * orchestration command handling.
 *
 * @module OrchestrationCommandReceiptRepository
 */
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationAggregateKind,
  OrchestrationCommandReceiptStatus,
  PositiveInt,
  ProjectId,
  ThreadId,
  WorktreeWorkspaceId,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { OrchestrationCommandReceiptRepositoryError } from "../Errors.ts";

const CommandFingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

const ReceiptFields = {
  commandId: CommandId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, WorktreeWorkspaceId, ThreadId]),
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: OrchestrationCommandReceiptStatus,
  error: Schema.NullOr(Schema.String),
} as const;

export const OrchestrationCommandReceipt = Schema.Struct({
  ...ReceiptFields,
  fingerprintVersion: Schema.NullOr(PositiveInt),
  commandFingerprint: Schema.NullOr(CommandFingerprint),
});
export type OrchestrationCommandReceipt = typeof OrchestrationCommandReceipt.Type;

export const NewOrchestrationCommandReceipt = Schema.Struct({
  ...ReceiptFields,
  fingerprintVersion: PositiveInt,
  commandFingerprint: CommandFingerprint,
});
export type NewOrchestrationCommandReceipt = typeof NewOrchestrationCommandReceipt.Type;

export const GetByCommandIdInput = Schema.Struct({
  commandId: CommandId,
});
export type GetByCommandIdInput = typeof GetByCommandIdInput.Type;

/**
 * OrchestrationCommandReceiptRepositoryShape - Service API for command receipts.
 */
export interface OrchestrationCommandReceiptRepositoryShape {
  /**
   * Insert a command receipt without replacing an existing command identity.
   *
   * Returns `false` when `commandId` already exists; callers must compare the stored
   * fingerprint and must never overwrite its original result.
   */
  readonly insert: (
    receipt: NewOrchestrationCommandReceipt,
  ) => Effect.Effect<boolean, OrchestrationCommandReceiptRepositoryError>;

  /**
   * Read a command receipt by command id.
   */
  readonly getByCommandId: (
    input: GetByCommandIdInput,
  ) => Effect.Effect<
    Option.Option<OrchestrationCommandReceipt>,
    OrchestrationCommandReceiptRepositoryError
  >;
}

/**
 * OrchestrationCommandReceiptRepository - Service tag for command receipt persistence.
 */
export class OrchestrationCommandReceiptRepository extends ServiceMap.Service<
  OrchestrationCommandReceiptRepository,
  OrchestrationCommandReceiptRepositoryShape
>()(
  "synara/persistence/Services/OrchestrationCommandReceipts/OrchestrationCommandReceiptRepository",
) {}
