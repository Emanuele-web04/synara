import * as nodePath from "node:path";

import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpAuthMethodSelector } from "./acp/AcpSessionRuntime.ts";

export const DEFAULT_HERMES_COMMAND = "hermes";
export const HERMES_TERMINAL_SETUP_AUTH_METHOD_ID = "hermes-setup";

export function resolveHermesAcpSpawn(binaryPath?: string): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  const command = binaryPath?.trim() || DEFAULT_HERMES_COMMAND;
  if (/^hermes(?:\.exe)?\s+acp$/iu.test(command)) {
    return { command: command.split(/\s+/u)[0] ?? DEFAULT_HERMES_COMMAND, args: ["acp"] };
  }

  const executableName = nodePath.basename(command).toLowerCase();
  if (executableName === "hermes" || executableName === "hermes.exe") {
    return { command, args: ["acp"] };
  }

  return { command, args: [] };
}

function readAuthMethodString(
  method: NonNullable<EffectAcpSchema.InitializeResponse["authMethods"]>[number],
  key: "id" | "type",
): string | undefined {
  const value = (method as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const selectHermesAuthMethodId: AcpAuthMethodSelector = ({ initializeResult }) => {
  const methods = initializeResult.authMethods ?? [];

  const agentManagedMethod = methods.find(
    (method) =>
      readAuthMethodString(method, "id") !== undefined &&
      readAuthMethodString(method, "type") === undefined,
  );
  const nonTerminalMethod = methods.find((method) => {
    const id = readAuthMethodString(method, "id");
    const type = readAuthMethodString(method, "type");
    return id !== undefined && type !== "terminal" && type !== "env_var";
  });
  const terminalSetupMethod = methods.find(
    (method) => readAuthMethodString(method, "id") === HERMES_TERMINAL_SETUP_AUTH_METHOD_ID,
  );

  return (
    (agentManagedMethod ? readAuthMethodString(agentManagedMethod, "id") : undefined) ??
    (nonTerminalMethod ? readAuthMethodString(nonTerminalMethod, "id") : undefined) ??
    (terminalSetupMethod ? readAuthMethodString(terminalSetupMethod, "id") : undefined)
  );
};
