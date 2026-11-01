import { t } from "~/i18n";
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

const RUNTIME_MODE_PRESENTATION_KEYS = {
  "approval-required": {
    label: "settings:runtimeAskLabel",
    description: "settings:runtimeAsk",
  },
  auto: {
    label: "settings:runtimeAutoLabel",
    description: "settings:runtimeAuto",
  },
  "full-access": {
    label: "settings:runtimeFullLabel",
    description: "settings:runtimeFull",
  },
} as const;

/**
 * Where a mode maps onto a provider's own mechanism, say what that provider does. Claude and
 * Codex implement the three modes differently (Claude Code's permission modes vs Codex's
 * sandbox + approval policy); every other provider keeps the generic wording.
 */
const PROVIDER_RUNTIME_MODE_DESCRIPTION_KEYS: Partial<
  Record<ProviderKind, Record<RuntimeMode, string>>
> = {
  claudeAgent: {
    "approval-required": "settings:runtimeClaudeAsk",
    auto: "settings:runtimeClaudeAuto",
    "full-access": "settings:runtimeClaudeFull",
  },
  codex: {
    "approval-required": "settings:runtimeCodexAsk",
    auto: "settings:runtimeCodexAuto",
    "full-access": "settings:runtimeCodexFull",
  },
};

export function runtimeModePresentation(
  mode: RuntimeMode,
  provider: ProviderKind | undefined,
  translate: typeof t = t,
): { readonly label: string; readonly description: string } {
  const presentation = RUNTIME_MODE_PRESENTATION_KEYS[mode];
  const descriptionKey = provider
    ? PROVIDER_RUNTIME_MODE_DESCRIPTION_KEYS[provider]?.[mode]
    : undefined;
  return {
    label: translate(presentation.label),
    description: translate(descriptionKey ?? presentation.description),
  };
}
