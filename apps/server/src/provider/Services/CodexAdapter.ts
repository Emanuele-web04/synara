import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface CodexAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "codex";
}

export class CodexAdapter extends ServiceMap.Service<CodexAdapter, CodexAdapterShape>()(
  "synara/provider/Services/CodexAdapter",
) {}
