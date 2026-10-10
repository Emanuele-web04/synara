import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationAggregateKind,
  OrchestrationCommandReceiptStatus,
  PositiveInt,
  ProjectId,
  SpaceId,
  ThreadId,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { OrchestrationCommandReceiptRepositoryError } from "../Errors.ts";

const CommandFingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

const ReceiptFields = {
  commandId: CommandId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([SpaceId, ProjectId, ThreadId]),
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

export interface OrchestrationCommandReceiptRepositoryShape {
  /** returns false when the commandId exists — callers compare the stored fingerprint and must never overwrite the original result */
  readonly insert: (
    receipt: NewOrchestrationCommandReceipt,
  ) => Effect.Effect<boolean, OrchestrationCommandReceiptRepositoryError>;

  readonly getByCommandId: (
    input: GetByCommandIdInput,
  ) => Effect.Effect<
    Option.Option<OrchestrationCommandReceipt>,
    OrchestrationCommandReceiptRepositoryError
  >;
}

export class OrchestrationCommandReceiptRepository extends ServiceMap.Service<
  OrchestrationCommandReceiptRepository,
  OrchestrationCommandReceiptRepositoryShape
>()(
  "synara/persistence/Services/OrchestrationCommandReceipts/OrchestrationCommandReceiptRepository",
) {}
