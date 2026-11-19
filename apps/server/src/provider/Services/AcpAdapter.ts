/**
 * AcpAdapter - generic Agent Client Protocol implementation of the provider
 * contract. One adapter serves every `acp`-driver provider instance; each
 * instance names the agent binary it launches.
 *
 * @module AcpAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface AcpAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "acp";
}

export class AcpAdapter extends ServiceMap.Service<AcpAdapter, AcpAdapterShape>()(
  "synara/provider/Services/AcpAdapter",
) {}
