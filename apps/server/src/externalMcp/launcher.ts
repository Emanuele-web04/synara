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

export function externalMcpShellCommand(config: ExternalMcpStdioConfiguration): string {
  const command = [config.command, ...config.args].map(quoteExternalMcpShellArgument).join(" ");
  const entries = Object.entries(config.env ?? {});
  if (entries.length === 0) return command;
  if (process.platform === "win32") {
    return `${entries.map(([key, value]) => `set ${quoteExternalMcpShellArgument(`${key}=${value}`)}`).join(" && ")} && ${command}`;
  }
  return `${entries
    .map(([key, value]) => `${key}=${quoteExternalMcpShellArgument(value)}`)
    .join(" ")} ${command}`;
}
