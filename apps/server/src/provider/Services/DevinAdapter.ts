import { ServiceMap } from "effect";

import type { ProviderAdapterShape } from "./ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";

export type DevinAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

export class DevinAdapter extends ServiceMap.Service<DevinAdapter, DevinAdapterShape>()(
  "synara/provider/Services/DevinAdapter",
) {}
