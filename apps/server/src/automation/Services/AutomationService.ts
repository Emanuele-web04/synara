import {
  AutomationCancelRunInput,
  AutomationCancelRunResult,
  AutomationCreateInput,
  AutomationDefinition,
  AutomationDeleteInput,
  AutomationListInput,
  AutomationListResult,
  AutomationRunNowInput,
  AutomationRunNowResult,
  AutomationStreamEvent,
  AutomationUpdateInput,
} from "@t3tools/contracts";
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
  readonly runNow: (
    input: AutomationRunNowInput,
  ) => Effect.Effect<AutomationRunNowResult, AutomationServiceError>;
  readonly cancelRun: (
    input: AutomationCancelRunInput,
  ) => Effect.Effect<AutomationCancelRunResult, AutomationServiceError>;
  readonly runDueOnce: (input?: {
    readonly now?: string;
    readonly limit?: number;
    readonly leaseOwnerId?: string;
  }) => Effect.Effect<ReadonlyArray<AutomationRunNowResult>, AutomationServiceError>;
  readonly streamEvents: Stream.Stream<AutomationStreamEvent, never, never>;
}

export class AutomationService extends ServiceMap.Service<
  AutomationService,
  AutomationServiceShape
>()("t3/automation/Services/AutomationService") {}
