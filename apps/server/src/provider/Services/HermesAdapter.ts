/**
 * HermesAdapter - Hermes Agent implementation of the generic provider adapter contract.
 *
 * Wraps Hermes' ACP entrypoint (`hermes acp`) behind the shared provider adapter
 * interface. Cross-provider routing and orchestration remain ProviderService concerns.
 *
 * @module HermesAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface HermesAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "hermes";
}

export class HermesAdapter extends ServiceMap.Service<HermesAdapter, HermesAdapterShape>()(
  "t3/provider/Services/HermesAdapter",
) {}
