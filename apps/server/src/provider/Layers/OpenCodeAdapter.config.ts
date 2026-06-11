// Purpose: Static adapter configuration and prompt-acceptance timeout constants for OpenCode/Kilo.
// Layer: pure constants — no Effect, no runtime state.
// Exports: OPENCODE_ADAPTER_CONFIG, KILO_ADAPTER_CONFIG, prompt-acceptance timing constants.

import { KILO_CLI_SPEC, OPENCODE_CLI_SPEC } from "../opencodeRuntime.ts";
import type { OpenCodeCompatibleAdapterConfig } from "./OpenCodeAdapter.types.ts";

export const OPENCODE_ADAPTER_CONFIG: OpenCodeCompatibleAdapterConfig = {
  provider: "opencode",
  displayName: "OpenCode",
  defaultBinaryPath: "opencode",
  providerOptionsKey: "opencode",
  runtimeEventSource: "opencode.sdk.event",
  turnIdPrefix: "opencode-turn",
  cliModelSource: "opencode-cli",
  fallbackModelSource: "opencode",
  defaultAgent: "build",
  planAgent: "plan",
  cliSpec: OPENCODE_CLI_SPEC,
};

export const KILO_ADAPTER_CONFIG: OpenCodeCompatibleAdapterConfig = {
  provider: "kilo",
  displayName: "Kilo",
  defaultBinaryPath: "kilo",
  providerOptionsKey: "kilo",
  runtimeEventSource: "kilo.sdk.event",
  turnIdPrefix: "kilo-turn",
  cliModelSource: "kilo-cli",
  fallbackModelSource: "kilo",
  defaultAgent: "code",
  planAgent: "plan",
  cliSpec: KILO_CLI_SPEC,
};

export const OPENCODE_PROMPT_ACCEPTED_ACTIVITY_TIMEOUT_MS = 60_000;
export const OPENCODE_PROMPT_ACCEPTED_RECOVERY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000] as const;
export const OPENCODE_PROMPT_SUBMISSION_INLINE_WAIT_MS = 500;
