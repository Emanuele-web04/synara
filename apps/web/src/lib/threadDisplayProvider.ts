import type { ProviderKind } from "@synara/contracts";

/** The live session's provider wins over the configured model selection. */
export function resolveThreadDisplayProvider(thread: {
  readonly session?: { readonly provider: ProviderKind } | null;
  readonly modelSelection: { readonly provider: ProviderKind };
}): ProviderKind {
  return thread.session?.provider ?? thread.modelSelection.provider;
}
