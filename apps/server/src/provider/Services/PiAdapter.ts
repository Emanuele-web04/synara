/**
 * PiAdapter - Pi direct SDK implementation of the generic provider adapter contract.
 *
 * Pi is intentionally treated as an unopinionated harness: Synara does not add
 * permissions or plan-mode semantics on top of it.
 *
 * @module PiAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "pi";
}

export class PiAdapter extends ServiceMap.Service<PiAdapter, PiAdapterShape>()(
  "synara/provider/Services/PiAdapter",
) {}
