/**
 * GrokAdapter - Grok Build CLI ACP implementation of the generic provider contract.
 *
 * @module GrokAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface GrokAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "grok";
}

export class GrokAdapter extends ServiceMap.Service<GrokAdapter, GrokAdapterShape>()(
  "synara/provider/Services/GrokAdapter",
) {}
