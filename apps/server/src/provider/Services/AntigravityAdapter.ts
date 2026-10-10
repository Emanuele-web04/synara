/** Antigravity CLI implementation of the generic provider adapter contract. */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface AntigravityAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "antigravity";
}

export class AntigravityAdapter extends ServiceMap.Service<
  AntigravityAdapter,
  AntigravityAdapterShape
>()("synara/provider/Services/AntigravityAdapter") {}
