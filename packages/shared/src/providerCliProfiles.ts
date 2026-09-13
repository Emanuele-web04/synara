// FILE: providerCliProfiles.ts
// Purpose: Derives stable, shell-neutral command names for provider instances.
// Layer: Shared provider presentation/runtime utility

import type { ProviderInstanceId, ProviderKind } from "@synara/contracts";

export const PROVIDER_CLI_COMMAND_BY_KIND = {
  codex: "codex",
  claudeAgent: "claude",
  cursor: "cursor-agent",
  devin: "devin",
  antigravity: "agy",
  grok: "grok",
  droid: "droid",
  opencode: "opencode",
  pi: "pi",
} as const satisfies Record<ProviderKind, string>;

const CLI_COMMAND_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESERVED_CLI_COMMANDS = new Set<string>(Object.values(PROVIDER_CLI_COMMAND_BY_KIND));

export function normalizeProviderCliAlias(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const alias = value.trim();
  return CLI_COMMAND_PATTERN.test(alias) && !RESERVED_CLI_COMMANDS.has(alias)
    ? alias
    : undefined;
}

function profileSuffix(provider: ProviderKind, instanceId: ProviderInstanceId): string {
  if (instanceId === provider) return "default";
  const command = PROVIDER_CLI_COMMAND_BY_KIND[provider];
  const prefixes = [provider.toLowerCase(), command.toLowerCase()]
    .flatMap((prefix) => [prefix, prefix.replaceAll("-", "")])
    .toSorted((left, right) => right.length - left.length);
  let candidate = String(instanceId);
  const normalizedCandidate = candidate.toLowerCase();
  const prefix = prefixes.find(
    (value) =>
      normalizedCandidate.startsWith(`${value}_`) || normalizedCandidate.startsWith(`${value}-`),
  );
  if (prefix) candidate = candidate.slice(prefix.length + 1);
  const slug = candidate
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/[_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || String(instanceId).toLowerCase();
}

export function providerCliCommandName(input: {
  readonly provider: ProviderKind;
  readonly instanceId: ProviderInstanceId;
  readonly config?: Readonly<Record<string, unknown>> | undefined;
}): string {
  const configured = normalizeProviderCliAlias(input.config?.cliAlias);
  if (configured) return configured;
  return `${PROVIDER_CLI_COMMAND_BY_KIND[input.provider]}-${profileSuffix(
    input.provider,
    input.instanceId,
  )}`;
}
