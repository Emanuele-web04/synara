/**
 * KiroAdapter - Kiro CLI (`kiro-cli acp`) implementation of the generic provider contract.
 *
 * @module KiroAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KiroAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "kiro";
}

export class KiroAdapter extends ServiceMap.Service<KiroAdapter, KiroAdapterShape>()(
  "synara/provider/Services/KiroAdapter",
) {}
