/**
 * DroidAdapter - Droid Build CLI ACP implementation of the generic provider contract.
 *
 * @module DroidAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface DroidAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "droid";
}

export class DroidAdapter extends ServiceMap.Service<DroidAdapter, DroidAdapterShape>()(
  "t3/provider/Services/DroidAdapter",
) {}
