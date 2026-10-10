import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface DroidAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "droid";
}

export class DroidAdapter extends ServiceMap.Service<DroidAdapter, DroidAdapterShape>()(
  "synara/provider/Services/DroidAdapter",
) {}
