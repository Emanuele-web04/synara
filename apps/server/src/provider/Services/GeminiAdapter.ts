/**
 * GeminiAdapter - Gemini CLI ACP implementation of the generic provider adapter contract.
 *
 * This service owns Gemini ACP runtime/session semantics and emits canonical
 * provider runtime events. It does not perform cross-provider routing, shared
 * event fan-out, or checkpoint orchestration.
 *
 * @module GeminiAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * GeminiAdapterShape - Service API for the Gemini provider adapter.
 */
export interface GeminiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "gemini";
}

/**
 * GeminiAdapter - Service tag for Gemini provider adapter operations.
 */
export class GeminiAdapter extends ServiceMap.Service<GeminiAdapter, GeminiAdapterShape>()(
  "t3/provider/Services/GeminiAdapter",
) {}
