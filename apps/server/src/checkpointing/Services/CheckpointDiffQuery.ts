import type {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CheckpointServiceError } from "../Errors.ts";

export interface CheckpointDiffQueryShape {
  readonly getTurnDiff: (
    input: OrchestrationGetTurnDiffInput,
  ) => Effect.Effect<OrchestrationGetTurnDiffResult, CheckpointServiceError>;

  readonly getFullThreadDiff: (
    input: OrchestrationGetFullThreadDiffInput,
  ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
}

export class CheckpointDiffQuery extends ServiceMap.Service<
  CheckpointDiffQuery,
  CheckpointDiffQueryShape
>()("synara/checkpointing/Services/CheckpointDiffQuery") {}
