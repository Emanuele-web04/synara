import { ServiceMap } from "effect";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ClineAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "cline";
}

export class ClineAdapter extends ServiceMap.Service<ClineAdapter, ClineAdapterShape>()(
  "synara/provider/Services/ClineAdapter",
) {}
