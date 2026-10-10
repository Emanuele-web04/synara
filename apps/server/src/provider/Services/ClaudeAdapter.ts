import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ClaudeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "claudeAgent";
  readonly steerTurn: NonNullable<ProviderAdapterShape<ProviderAdapterError>["steerTurn"]>;
  readonly stopTask: NonNullable<ProviderAdapterShape<ProviderAdapterError>["stopTask"]>;
  readonly backgroundTask: NonNullable<
    ProviderAdapterShape<ProviderAdapterError>["backgroundTask"]
  >;
  readonly steerSubagent: NonNullable<ProviderAdapterShape<ProviderAdapterError>["steerSubagent"]>;
}

export class ClaudeAdapter extends ServiceMap.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "synara/provider/Services/ClaudeAdapter",
) {}
