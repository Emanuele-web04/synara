/**
 * KimiAdapter - Kimi Code CLI ACP implementation of the generic provider contract.
 *
 * @module KimiAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KimiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "kimi";
}

export class KimiAdapter extends ServiceMap.Service<KimiAdapter, KimiAdapterShape>()(
  "t3/provider/Services/KimiAdapter",
) {}
