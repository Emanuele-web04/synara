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
    label: "Ask for approval",
    description: "Always ask to edit external files and use the internet",
  },
  auto: {
    label: "Approve for me",
    description: "Only ask for actions detected as potentially unsafe",
  },
  "full-access": {
    label: "Full access",
    description: "Unrestricted access to the internet and any file on your computer",
  },
};

/**
 * Where a mode maps onto a provider's own mechanism, say what that provider does. Claude and
 * Codex implement the three modes differently (Claude Code's permission modes vs Codex's
 * sandbox + approval policy); every other provider keeps the generic wording above.
 */
const PROVIDER_RUNTIME_MODE_DESCRIPTIONS: Partial<
  Record<ProviderKind, Record<RuntimeMode, string>>
> = {
  claudeAgent: {
    "approval-required": "Claude asks before editing files, running commands, or using the web",
    auto: "Claude Code's auto mode: a classifier approves or blocks each action and asks you when unsure",
    "full-access": "Claude runs every action without asking, with full access to your computer",
  },
  codex: {
    "approval-required": "Read-only sandbox: Codex asks before editing files or running commands",
    auto: "Codex edits inside the project; its reviewer decides on anything that needs more access",
    "full-access":
      "No sandbox: Codex runs everything without asking, with full access to your computer",
  },
};

export function runtimeModePresentation(
  mode: RuntimeMode,
  provider: ProviderKind | undefined,
): { readonly label: string; readonly description: string } {
  const description = provider ? PROVIDER_RUNTIME_MODE_DESCRIPTIONS[provider]?.[mode] : undefined;
  const presentation = RUNTIME_MODE_PRESENTATION[mode];
  return description ? { ...presentation, description } : presentation;
}
