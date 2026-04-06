import type {
  ClaudeModelOptions,
  CodexModelOptions,
  ProviderKind,
  ProviderModelOptions,
} from "@t3tools/contracts";

export type ProviderOptions = ProviderModelOptions[ProviderKind];

export function buildNextProviderOptions(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
  patch: Record<string, unknown>,
): ProviderOptions {
  if (provider === "codex") {
    return { ...(modelOptions as CodexModelOptions | undefined), ...patch } as CodexModelOptions;
  }
  return { ...(modelOptions as ClaudeModelOptions | undefined), ...patch } as ClaudeModelOptions;
}
