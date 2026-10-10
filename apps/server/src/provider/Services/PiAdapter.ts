/** Pi is intentionally an unopinionated harness: Synara adds no permissions or plan-mode semantics on top of it. */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "pi";
}

export class PiAdapter extends ServiceMap.Service<PiAdapter, PiAdapterShape>()(
  "synara/provider/Services/PiAdapter",
) {}
