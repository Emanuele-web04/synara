import type { ExternalMcpCapability, ExternalMcpStdioConfiguration } from "@synara/contracts";

export const EXTERNAL_MCP_CLIENTS = {
  codex: {
    label: "Codex",
    description: "Add Synara to Codex with one terminal command.",
    suggestedName: "Codex",
  },
  claudeCode: {
    label: "Claude Code",
    description: "Add Synara to Claude Code for your user account.",
    suggestedName: "Claude Code",
  },
  claudeDesktop: {
    label: "Claude Desktop",
    description: "Copy a ready-to-paste local MCP configuration.",
    suggestedName: "Claude Desktop",
  },
  other: {
    label: "Other MCP app",
    description: "Use the standard stdio MCP configuration.",
    suggestedName: "MCP app",
  },
} as const;

export type ExternalMcpClientKind = keyof typeof EXTERNAL_MCP_CLIENTS;

export interface ExternalMcpClientConfiguration {
  readonly format: "command" | "json";
  readonly value: string;
  readonly copyLabel: string;
  readonly instruction: string;
}

export type ExternalMcpSetupAction = "resume-pairing" | "revoke" | "done" | null;

export function externalMcpSetupAction(input: {
  readonly revoked: boolean;
  readonly integrationExpired: boolean;
  readonly paired: boolean;
  readonly pairingExpired: boolean;
}): ExternalMcpSetupAction {
  if (input.revoked || input.integrationExpired) return "revoke";
  if (!input.paired && input.pairingExpired) return "resume-pairing";
  return input.paired ? "done" : null;
}

function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(parts: ReadonlyArray<string>, platform: string): string {
  if (/win/i.test(platform)) {
    return `& ${parts.map((part) => `'${part.replaceAll("'", "''")}'`).join(" ")}`;
  }
  return parts.map(quoteShellArgument).join(" ");
}

function jsonConfiguration(stdio: ExternalMcpStdioConfiguration): string {
  return JSON.stringify(
    {
      mcpServers: {
        synara: {
          command: stdio.command,
          args: stdio.args,
          ...(stdio.env ? { env: stdio.env } : {}),
        },
      },
    },
    null,
    2,
  );
}

export function buildExternalMcpClientConfiguration(
  client: ExternalMcpClientKind,
  stdio: ExternalMcpStdioConfiguration,
  platform = "",
): ExternalMcpClientConfiguration {
  if (client === "codex") {
    const environment = Object.entries(stdio.env ?? {}).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]);
    return {
      format: "command",
      value: shellCommand(
        [
          "codex",
          "mcp",
          "add",
          "synara",
          ...environment,
          "--",
          stdio.command,
          ...stdio.args,
        ],
        platform,
      ),
      copyLabel: "Copy Codex command",
      instruction:
        /win/i.test(platform)
          ? "Run this command in PowerShell. Codex will save Synara as a local MCP server; then open a new Codex task."
          : "Run this command in Terminal. Codex will save Synara as a local MCP server; then open a new Codex task.",
    };
  }

  if (client === "claudeCode") {
    const environment = Object.entries(stdio.env ?? {}).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]);
    return {
      format: "command",
      value: shellCommand(
        [
          "claude",
          "mcp",
          "add",
          "--scope",
          "user",
          "synara",
          ...environment,
          "--",
          stdio.command,
          ...stdio.args,
        ],
        platform,
      ),
      copyLabel: "Copy Claude command",
      instruction: /win/i.test(platform)
        ? "Run this command in PowerShell. Claude Code will make Synara available in all your projects."
        : "Run this command in Terminal. Claude Code will make Synara available in all your projects.",
    };
  }

  return {
    format: "json",
    value: jsonConfiguration(stdio),
    copyLabel: "Copy configuration",
    instruction:
      client === "claudeDesktop"
        ? "In Claude Desktop, open Settings → Developer → Edit Config. Add the Synara entry without removing existing servers, save, and restart Claude Desktop."
        : "Paste this into your app's local stdio MCP configuration.",
  };
}

export function buildExternalMcpExamplePrompt(projectTitle: string): string {
  return [
    `Use Synara to create a new task in the project named ${JSON.stringify(projectTitle)}.`,
    "First inspect Synara's capabilities and choose an exact available provider and model; do not guess model names.",
    "Use an isolated managed worktree and approval-required execution.",
    "Goal: [DESCRIBE THE WORK].",
    "Wait for the task to finish, then read the result and summarize it for me.",
  ].join(" ");
}

export function describeExternalMcpPermissions(
  capabilities: ReadonlyArray<ExternalMcpCapability>,
): string {
  const descriptions = ["Create and follow its own tasks"];
  if (capabilities.includes("tasks:read-project")) {
    descriptions.push("Read other tasks in selected projects");
  }
  if (capabilities.includes("runtime:local")) {
    descriptions.push("Use the shared local checkout");
  }
  if (capabilities.includes("runtime:full-access")) {
    descriptions.push("Run without approval prompts");
  }
  return descriptions.join(" · ");
}
