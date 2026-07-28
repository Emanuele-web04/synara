import type {
  ProviderKind,
  ProviderModelDescriptor,
  RuntimeMode,
  ServerProviderStatus,
} from "@synara/contracts";
import {
  normalizeRuntimeModeForProvider,
  providerSupportsAutoRuntimeMode,
} from "@synara/shared/runtimeMode";

export { normalizeRuntimeModeForProvider, providerSupportsAutoRuntimeMode };

export function providerModelSupportsAutoRuntimeMode(
  provider: ProviderKind,
  runtimeModel?: ProviderModelDescriptor,
  providerStatus?: ServerProviderStatus | null,
): boolean {
  if (!providerSupportsAutoRuntimeMode(provider)) {
    return false;
  }
  return (
    providerStatus?.supportsAutoRuntimeMode === true &&
    (provider !== "claudeAgent" || runtimeModel?.supportsAutoMode === true)
  );
}

export const RUNTIME_MODE_PRESENTATION: Record<
  RuntimeMode,
  { readonly label: string; readonly description: string }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  auto: {
    label: "Auto",
    description:
      "An AI reviewer handles routine approvals; higher-risk actions may be blocked or ask you.",
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
};
