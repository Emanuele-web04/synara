/**
 * ProviderHealth.config - Static provider constants and update definitions.
 *
 * Purpose: provider-kind constants, the provider probe list, timeout values,
 * package-managed update definitions, and native-install path predicates.
 * Layer: pure config (consumed by ProviderHealth and its check builders).
 * Exports: provider kind constants, PROVIDERS, ProviderStatuses,
 *   DEFAULT_TIMEOUT_MS, UPDATE_OUTPUT_MAX_BYTES, UPDATE_TIMEOUT_MS,
 *   OPENAI_AUTH_PROVIDERS, PACKAGE_MANAGED_PROVIDER_UPDATES.
 *
 * @module ProviderHealth.config
 */
import type { ProviderKind, ServerProviderStatus } from "@t3tools/contracts";

import { normalizeCommandPath } from "../providerMaintenance";
import type { PackageManagedProviderMaintenanceDefinition } from "../providerMaintenance";

export const DEFAULT_TIMEOUT_MS = 4_000;
export const CODEX_PROVIDER = "codex" as const;
export const CLAUDE_AGENT_PROVIDER = "claudeAgent" as const;
export const CURSOR_PROVIDER = "cursor" as const;
export const GEMINI_PROVIDER = "gemini" as const;
export const GROK_PROVIDER = "grok" as const;
export const KILO_PROVIDER = "kilo" as const;
export const OPENCODE_PROVIDER = "opencode" as const;
export const PI_PROVIDER = "pi" as const;
export type ProviderStatuses = ReadonlyArray<ServerProviderStatus>;

export const PROVIDERS = [
  CODEX_PROVIDER,
  CLAUDE_AGENT_PROVIDER,
  CURSOR_PROVIDER,
  GEMINI_PROVIDER,
  GROK_PROVIDER,
  KILO_PROVIDER,
  OPENCODE_PROVIDER,
  PI_PROVIDER,
] as const satisfies ReadonlyArray<ProviderKind>;

export const UPDATE_OUTPUT_MAX_BYTES = 10_000;
export const UPDATE_TIMEOUT_MS = 5 * 60_000;

/**
 * Providers that use OpenAI-native authentication via `codex login`.
 * When the configured `model_provider` is one of these, the `codex login
 * status` probe still runs. For any other provider value the auth probe
 * is skipped because authentication is handled externally (e.g. via
 * environment variables like `PORTKEY_API_KEY` or `AZURE_API_KEY`).
 */
export const OPENAI_AUTH_PROVIDERS = new Set(["openai"]);

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

export const PACKAGE_MANAGED_PROVIDER_UPDATES: Partial<
  Record<ProviderKind, PackageManagedProviderMaintenanceDefinition>
> = {
  codex: {
    provider: CODEX_PROVIDER,
    binaryName: "codex",
    npmPackageName: "@openai/codex",
    homebrew: { name: "codex", kind: "cask" },
    nativeUpdate: null,
  },
  claudeAgent: {
    provider: CLAUDE_AGENT_PROVIDER,
    binaryName: "claude",
    npmPackageName: "@anthropic-ai/claude-code",
    homebrew: { name: "claude-code", kind: "cask" },
    nativeUpdate: {
      executable: "claude",
      args: () => ["update"],
      lockKey: "claude-native",
      strategy: "matching-path",
      isCommandPath: isClaudeNativeCommandPath,
    },
  },
  gemini: {
    provider: GEMINI_PROVIDER,
    binaryName: "gemini",
    npmPackageName: "@google/gemini-cli",
    homebrew: { name: "gemini-cli", kind: "formula" },
    nativeUpdate: null,
  },
  kilo: {
    provider: KILO_PROVIDER,
    binaryName: "kilo",
    npmPackageName: "@kilocode/cli",
    homebrew: null,
    nativeUpdate: {
      executable: "kilo",
      args: () => ["upgrade"],
      lockKey: "kilo-native",
      strategy: "always",
    },
  },
  opencode: {
    provider: OPENCODE_PROVIDER,
    binaryName: "opencode",
    npmPackageName: "opencode-ai",
    homebrew: { name: "anomalyco/tap/opencode", kind: "formula" },
    latestVersionSource: { kind: "npm", name: "opencode-ai" },
    nativeUpdate: {
      executable: "opencode",
      args: (installSource) =>
        installSource === "unknown" || installSource === "native"
          ? ["upgrade"]
          : ["upgrade", "--method", installSource],
      lockKey: "opencode-native",
      strategy: "always",
      excludedInstallSources: ["homebrew"],
      isCommandPath: isOpenCodeNativeCommandPath,
    },
  },
  pi: {
    provider: PI_PROVIDER,
    binaryName: "pi",
    npmPackageName: "@earendil-works/pi-coding-agent",
    homebrew: null,
    nativeUpdate: {
      executable: "pi",
      args: () => ["update"],
      lockKey: "pi-native",
      strategy: "always",
    },
  },
};
