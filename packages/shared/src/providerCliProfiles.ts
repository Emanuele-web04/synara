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
  omp: "omp",
} as const satisfies Record<Exclude<ProviderKind, "external">, string>;

const CLI_COMMAND_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESERVED_CLI_COMMANDS = new Set<string>(Object.values(PROVIDER_CLI_COMMAND_BY_KIND));

export function normalizeProviderCliAlias(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const alias = value.trim();
  return CLI_COMMAND_PATTERN.test(alias) && !RESERVED_CLI_COMMANDS.has(alias) ? alias : undefined;
}

function profileSuffix(
  provider: Exclude<ProviderKind, "external">,
  instanceId: ProviderInstanceId,
): string {
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
  if (input.provider === "external")
    throw new Error(
      "External profiles own their launch command; no built-in CLI alias is available.",
    );
  const configured = normalizeProviderCliAlias(input.config?.cliAlias);
  if (configured) return configured;
  return `${PROVIDER_CLI_COMMAND_BY_KIND[input.provider]}-${profileSuffix(
    input.provider,
    input.instanceId,
  )}`;
}

// Login entry points verified against each CLI's authentication documentation.
// Pi-family /login is a TUI command: never pass it as a model prompt argument.
export const PROVIDER_AUTHENTICATION = {
  codex: {
    args: ["login"],
    instructions: "Complete the browser sign-in. Synara will check this account afterward.",
  },
  claudeAgent: {
    args: ["auth", "login"],
    instructions:
      "Choose your login method and complete the browser sign-in, including any Apple or organization prompts.",
  },
  cursor: { args: ["login"], instructions: "Complete the Cursor browser sign-in." },
  devin: {
    args: ["auth", "login"],
    instructions:
      "Choose your Devin or Windsurf login and follow the browser or enterprise sign-in prompts.",
  },
  antigravity: {
    args: [],
    instructions:
      "Follow Antigravity's sign-in prompts. Your browser or system credential store may ask for approval.",
  },
  grok: {
    args: ["login"],
    instructions: "Complete the Grok browser sign-in or the authorization steps shown below.",
  },
  droid: { args: [], instructions: "Follow Droid's startup and browser sign-in prompts." },
  opencode: {
    args: ["auth", "login"],
    instructions: "Choose a model provider, then complete its OAuth or API-key setup.",
  },
  pi: {
    args: [],
    instructions:
      "Complete any startup prompts, then choose Sign-in options to select a model provider and authenticate.",
    interactiveCommand: "/login",
  },
  omp: {
    args: [],
    instructions:
      "Complete any startup prompts, then choose Sign-in options to select a model provider and authenticate.",
    interactiveCommand: "/login",
  },
} as const satisfies Record<
  Exclude<ProviderKind, "external">,
  {
    readonly args: readonly string[];
    readonly instructions: string;
    readonly interactiveCommand?: string;
  }
>;
