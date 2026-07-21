import type { ExternalMcpStdioConfiguration } from "@synara/contracts";

import { quoteExternalMcpShellArgument } from "./shell.ts";

function executableEntry(): { readonly command: string; readonly prefix: ReadonlyArray<string> } {
  const entry = process.env.SYNARA_SERVER_ENTRY?.trim() || process.argv[1];
  return entry
    ? { command: process.execPath, prefix: [entry] }
    : { command: process.execPath, prefix: [] };
}

function launcherEnvironment(): Readonly<Record<string, string>> | undefined {
  return process.env.ELECTRON_RUN_AS_NODE === "1" ? { ELECTRON_RUN_AS_NODE: "1" } : undefined;
}

export function externalMcpLauncher(args: ReadonlyArray<string>): ExternalMcpStdioConfiguration {
  const executable = executableEntry();
  const env = launcherEnvironment();
  return {
    command: executable.command,
    args: [...executable.prefix, ...args],
    ...(env ? { env } : {}),
  };
}

const quotePowerShellArgument = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function externalMcpShellCommand(
  config: ExternalMcpStdioConfiguration,
  platform: NodeJS.Platform = process.platform,
): string {
  const parts = [config.command, ...config.args];
  const entries = Object.entries(config.env ?? {});
  if (platform === "win32") {
    const environment = entries
      .map(([key, value]) => `$env:${key} = ${quotePowerShellArgument(value)}`)
      .join("; ");
    const command = `& ${parts.map(quotePowerShellArgument).join(" ")}`;
    return environment ? `${environment}; ${command}` : command;
  }
  const command = parts.map(quoteExternalMcpShellArgument).join(" ");
  if (entries.length === 0) return command;
  return `${entries
    .map(([key, value]) => `${key}=${quoteExternalMcpShellArgument(value)}`)
    .join(" ")} ${command}`;
}
