/**
 * DevinAdapter - Devin CLI implementation of the generic provider adapter contract.
 *
 * @module DevinAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface DevinAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "devin";
}

export class DevinAdapter extends ServiceMap.Service<DevinAdapter, DevinAdapterShape>()(
  "t3/provider/Services/DevinAdapter",
) {}
