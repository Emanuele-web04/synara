import { ServiceMap } from "effect";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface MuseAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "muse";
}
export class MuseAdapter extends ServiceMap.Service<MuseAdapter, MuseAdapterShape>()(
  "synara/provider/Services/MuseAdapter",
) {}
