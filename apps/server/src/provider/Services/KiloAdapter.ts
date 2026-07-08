/**
 * KiloAdapter - Kilo implementation of the generic provider adapter contract.
 *
 * Kilo's CLI/server API is OpenCode-compatible, so the live layer reuses the
 * OpenCode adapter implementation with Kilo-specific process settings.
 *
 * @module KiloAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KiloAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "kilo";
}

export class KiloAdapter extends ServiceMap.Service<KiloAdapter, KiloAdapterShape>()(
  "synara/provider/Services/KiloAdapter",
) {}
