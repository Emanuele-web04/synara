import type { GitBranch, ProviderKind } from "@t3tools/contracts";

export const BUILT_IN_COMPOSER_SLASH_COMMANDS = [
  "clear",
  "compact",
  "model",
  "plan",
  "default",
  "review",
  "fork",
  "side",
  "status",
  "subagents",
  "fast",
] as const;

export type ComposerSlashCommand = (typeof BUILT_IN_COMPOSER_SLASH_COMMANDS)[number];

export interface ComposerSlashCommandDefinition {
  command: ComposerSlashCommand;
  label: `/${ComposerSlashCommand}`;
  description: string;
  source: "app" | "shared";
}

export interface ComposerSlashInvocation {
  command: ComposerSlashCommand;
  args: string;
}

export type FastSlashCommandAction = "toggle" | "on" | "off" | "status" | "invalid";
export type ForkSlashCommandTarget = "local" | "worktree";

function normalizeSlashCommandName(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

const CLAUDE_NATIVE_COMMAND_ALIASES: Record<string, readonly string[]> = {
  clear: ["reset", "new"],
  config: ["settings"],
  desktop: ["app"],
  exit: ["quit"],
  feedback: ["bug"],
  branch: ["fork"],
  mobile: ["ios", "android"],
  permissions: ["allowed-tools"],
  "remote-control": ["rc"],
  resume: ["continue"],
};

function getProviderNativeSlashCommandAliases(
  provider: ProviderKind,
  command: string,
): readonly string[] {
  const normalizedCommand = normalizeSlashCommandName(command);
  if (provider !== "claudeAgent") {
    return [];
  }
  return CLAUDE_NATIVE_COMMAND_ALIASES[normalizedCommand] ?? [];
}

function expandProviderNativeSlashCommandNames(
  provider: ProviderKind,
  commandNames: ReadonlyArray<string>,
): string[] {
  const expandedNames = new Set<string>();
  for (const commandName of commandNames) {
    const normalizedCommandName = normalizeSlashCommandName(commandName);
    if (!normalizedCommandName) {
      continue;
    }
    expandedNames.add(normalizedCommandName);
    for (const alias of getProviderNativeSlashCommandAliases(provider, normalizedCommandName)) {
      expandedNames.add(alias);
    }
  }
  return [...expandedNames];
}

function shouldKeepBuiltInSlashCommandDespiteNativeCollision(
  provider: ProviderKind,
  command: ComposerSlashCommand,
): boolean {
  return provider === "codex" && command === "review";
}

export function shouldHideProviderNativeCommandFromComposerMenu(
  provider: ProviderKind,
  command: string,
): boolean {
  const normalizedCommand = normalizeSlashCommandName(command);
  return provider === "codex" && normalizedCommand === "review";
}

export function getProviderNativeSlashCommandSearchTerms(
  provider: ProviderKind,
  command: string,
): readonly string[] {
  const normalizedCommand = normalizeSlashCommandName(command);
  return [normalizedCommand, ...getProviderNativeSlashCommandAliases(provider, normalizedCommand)];
}

const COMPOSER_SLASH_COMMAND_DEFINITIONS: Record<
  ComposerSlashCommand,
  ComposerSlashCommandDefinition
> = {
  clear: {
    command: "clear",
    label: "/clear",
    description: "Start a fresh thread and clear the current conversation context",
    source: "shared",
  },
  compact: {
    command: "compact",
    label: "/compact",
    description: "Compact the current thread context to free space",
    source: "app",
  },
  model: {
    command: "model",
    label: "/model",
    description: "Switch response model for this thread",
    source: "shared",
  },
  plan: {
    command: "plan",
    label: "/plan",
    description: "Switch this thread into plan mode",
    source: "app",
  },
  default: {
    command: "default",
    label: "/default",
    description: "Switch this thread back to normal chat mode",
    source: "app",
  },
  review: {
    command: "review",
    label: "/review",
    description: "Start a code review for current changes",
    source: "app",
  },
  fork: {
    command: "fork",
    label: "/fork",
    description: "Fork this thread into local or a new worktree",
    source: "app",
  },
  side: {
    command: "side",
    label: "/side",
    description: "Open a guarded sidechat from this thread",
    source: "app",
  },
  status: {
    command: "status",
    label: "/status",
    description: "Show context usage and rate-limit status",
    source: "app",
  },
  subagents: {
    command: "subagents",
    label: "/subagents",
    description: "Insert a prompt that asks the assistant to delegate work",
    source: "app",
  },
  fast: {
    command: "fast",
    label: "/fast",
    description: "Turn fast mode on or off for this thread",
    source: "app",
  },
};

export function isBuiltInComposerSlashCommand(value: string): value is ComposerSlashCommand {
  const normalizedValue = normalizeSlashCommandName(value);
  return BUILT_IN_COMPOSER_SLASH_COMMANDS.some((command) => command === normalizedValue);
}

export function parseComposerSlashInvocation(text: string): ComposerSlashInvocation | null {
  return parseComposerSlashInvocationForCommands(text, BUILT_IN_COMPOSER_SLASH_COMMANDS);
}

export function parseComposerSlashInvocationForCommands(
  text: string,
  commands: ReadonlyArray<ComposerSlashCommand>,
): ComposerSlashInvocation | null {
  const match = /^\/([a-z-]+)(?:\s+(.*))?$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = normalizeSlashCommandName(match[1] ?? "");
  if (!command || !commands.includes(command as ComposerSlashCommand)) {
    return null;
  }
  return {
    command: command as ComposerSlashCommand,
    args: (match[2] ?? "").trim(),
  };
}

export function getComposerSlashCommandDefinition(
  command: ComposerSlashCommand,
): ComposerSlashCommandDefinition {
  return COMPOSER_SLASH_COMMAND_DEFINITIONS[command];
}

export function filterComposerSlashCommands(
  query: string,
  commands: ReadonlyArray<ComposerSlashCommand> = BUILT_IN_COMPOSER_SLASH_COMMANDS,
): ComposerSlashCommandDefinition[] {
  const normalizedQuery = query.trim().toLowerCase();
  const matches = commands.filter((command) => {
    if (!normalizedQuery) {
      return true;
    }
    const definition = COMPOSER_SLASH_COMMAND_DEFINITIONS[command];
    return (
      command.includes(normalizedQuery) ||
      definition.label.slice(1).includes(normalizedQuery) ||
      definition.description.toLowerCase().includes(normalizedQuery)
    );
  });

  return matches.map((command) => COMPOSER_SLASH_COMMAND_DEFINITIONS[command]);
}

function hasMeaningfulComposerText(prompt: string): boolean {
  return prompt.trim().length > 0;
}

export function canOfferForkSlashCommand(input: {
  prompt: string;
  imageCount: number;
  terminalContextCount: number;
  selectedSkillCount: number;
  selectedMentionCount: number;
  interactionMode: "default" | "plan";
}): boolean {
  return (
    !hasMeaningfulComposerText(input.prompt) &&
    input.imageCount === 0 &&
    input.terminalContextCount === 0 &&
    input.selectedSkillCount === 0 &&
    input.selectedMentionCount === 0 &&
    input.interactionMode === "default"
  );
}

export function canOfferSideSlashCommand(input: {
  prompt: string;
  imageCount: number;
  terminalContextCount: number;
  selectedSkillCount: number;
  selectedMentionCount: number;
  interactionMode: "default" | "plan";
  isSidechat: boolean;
}): boolean {
  return (
    !hasMeaningfulComposerText(input.prompt) &&
    input.imageCount === 0 &&
    input.terminalContextCount === 0 &&
    input.selectedSkillCount === 0 &&
    input.selectedMentionCount === 0 &&
    input.interactionMode === "default" &&
    !input.isSidechat
  );
}

export function canOfferReviewSlashCommand(input: {
  prompt: string;
  imageCount: number;
  terminalContextCount: number;
  selectedSkillCount: number;
  selectedMentionCount: number;
}): boolean {
  return (
    !hasMeaningfulComposerText(input.prompt) &&
    input.imageCount === 0 &&
    input.terminalContextCount === 0 &&
    input.selectedSkillCount === 0 &&
    input.selectedMentionCount === 0
  );
}

export function buildSubagentsPrompt(existingPrompt: string): string {
  const cannedPrompt =
    "Run subagents for different tasks. Delegate distinct work in parallel when helpful and then synthesize the results.";
  const trimmedPrompt = existingPrompt.trim();
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${cannedPrompt}` : cannedPrompt;
}

export function buildReviewPrompt(input: { target: "changes" | "base-branch" }): string {
  const baseInstruction =
    "Review the local code changes for bugs, risks, behavioural regressions, and missing tests. Findings first, ordered by severity.";
  if (input.target === "base-branch") {
    return `${baseInstruction}\nFocus on the current branch diff against its base branch.`;
  }
  return `${baseInstruction}\nFocus on the current uncommitted changes.`;
}

export function parseFastSlashCommandAction(text: string): FastSlashCommandAction | null {
  const invocation = parseComposerSlashInvocation(text);
  if (!invocation || invocation.command !== "fast") {
    return null;
  }
  const arg = invocation.args.toLowerCase();
  if (!arg) {
    return "toggle";
  }
  if (arg === "on") {
    return "on";
  }
  if (arg === "off") {
    return "off";
  }
  if (arg === "status") {
    return "status";
  }
  return "invalid";
}

export function resolveComposerSlashRootBranch(input: {
  branches: ReadonlyArray<GitBranch> | null | undefined;
  activeProjectCwd: string | null | undefined;
  activeThreadBranch: string | null | undefined;
}): string | null {
  return (
    input.branches?.find(
      (branch) =>
        branch.current === true &&
        (branch.worktreePath === null ||
          branch.worktreePath === undefined ||
          branch.worktreePath === input.activeProjectCwd),
    )?.name ??
    input.branches?.find((branch) => branch.current === true)?.name ??
    input.activeThreadBranch ??
    null
  );
}

export function getAvailableComposerSlashCommands(input: {
  provider: ProviderKind;
  supportsFastSlashCommand: boolean;
  canOfferCompactCommand: boolean;
  canOfferReviewCommand: boolean;
  canOfferForkCommand: boolean;
  canOfferSideCommand: boolean;
  providerNativeCommandNames?: ReadonlyArray<string>;
}): ComposerSlashCommand[] {
  const collidingNativeCommandNames = new Set<ComposerSlashCommand>(
    expandProviderNativeSlashCommandNames(
      input.provider,
      input.providerNativeCommandNames ?? [],
    ).filter(
      (name): name is ComposerSlashCommand =>
        isBuiltInComposerSlashCommand(name) &&
        !shouldKeepBuiltInSlashCommandDespiteNativeCollision(input.provider, name),
    ),
  );

  const availableCommands: ComposerSlashCommand[] =
    input.provider !== "claudeAgent"
      ? [
          "clear",
          ...(input.canOfferCompactCommand ? (["compact"] as const) : []),
          "model",
          ...(input.supportsFastSlashCommand ? (["fast"] as const) : []),
          "plan",
          "default",
          ...(input.canOfferReviewCommand ? (["review"] as const) : []),
          ...(input.canOfferForkCommand ? (["fork"] as const) : []),
          ...(input.canOfferSideCommand ? (["side"] as const) : []),
          "status",
          "subagents",
        ]
      : [
          // Claude owns most slash-command UX natively; sidechat remains app-level because it
          // creates a DP Code split/context clone before the provider sees the first turn.
          ...(input.canOfferSideCommand ? (["side"] as const) : []),
        ];
  return availableCommands.filter((command) => !collidingNativeCommandNames.has(command));
}

export function hasProviderNativeSlashCommand(
  provider: ProviderKind,
  commandNames: ReadonlyArray<string>,
  command: string,
): boolean {
  const normalizedCommand = normalizeSlashCommandName(command);
  return expandProviderNativeSlashCommandNames(provider, commandNames).includes(normalizedCommand);
}

export function buildSlashReviewComposerPrompt(args: string): string {
  const trimmedArgs = args.trim();
  const normalizedArgs = trimmedArgs.toLowerCase();
  const reviewTarget =
    normalizedArgs === "base" || normalizedArgs.startsWith("base ") ? "base-branch" : "changes";
  const basePrompt = buildReviewPrompt({ target: reviewTarget });
  if (!trimmedArgs) {
    return basePrompt;
  }
  if (reviewTarget === "base-branch") {
    const baseBranchHint = trimmedArgs.replace(/^base\b/i, "").trim();
    return baseBranchHint.length > 0
      ? `${basePrompt}\nUse ${baseBranchHint} as the base branch if needed.`
      : basePrompt;
  }
  return `${basePrompt}\nFocus especially on: ${trimmedArgs}`;
}

// `/fork` optionally accepts only an explicit target shorthand like `/fork local`.
export function parseForkSlashCommandArgs(args: string): {
  target: ForkSlashCommandTarget | null;
  invalid: boolean;
} {
  const trimmedArgs = args.trim();
  if (!trimmedArgs) {
    return { target: null, invalid: false };
  }

  const match = /^(local|worktree)$/i.exec(trimmedArgs);
  if (!match) {
    return { target: null, invalid: true };
  }

  return {
    target: match[1]!.toLowerCase() as ForkSlashCommandTarget,
    invalid: false,
  };
}
