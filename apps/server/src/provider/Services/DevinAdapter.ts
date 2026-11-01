/**
 * DevinAdapter - Devin CLI ACP implementation of the generic provider contract.
 *
 * @module DevinAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface DevinAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "devin";
  readonly stopTask: NonNullable<ProviderAdapterShape<ProviderAdapterError>["stopTask"]>;
  readonly backgroundTask: NonNullable<
    ProviderAdapterShape<ProviderAdapterError>["backgroundTask"]
  >;
}

export class DevinAdapter extends ServiceMap.Service<DevinAdapter, DevinAdapterShape>()(
  "synara/provider/Services/DevinAdapter",
) {}
