/**
 * Shared CLI version/auth probe helpers for provider health checks.
 *
 * @module cliProviderHealthProbe
 */
import type {
  ProviderKind,
  ServerProviderAuthStatus,
  ServerProviderStatus,
} from "@t3tools/contracts";
import { Effect, Option, Result } from "effect";

import { parseGenericCliVersion } from "../providerMaintenance";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const PROVIDER_COMMAND_TIMEOUT_DETAIL = "Timed out while running command.";

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return PROVIDER_COMMAND_TIMEOUT_DETAIL;
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

export interface CliVersionProbeMessages {
  readonly notInstalled: string;
  readonly failedToExecute: string;
  readonly timedOut: string;
  readonly failedToRunPrefix: string;
}

export type CliVersionProbeSuccess = {
  readonly ok: true;
  readonly version: CommandResult;
  readonly parsedVersion: string | undefined;
  readonly checkedAt: string;
};

export type CliVersionProbeFailure = {
  readonly ok: false;
  readonly status: ServerProviderStatus;
};

export function runCliVersionHealthProbe<R>(input: {
  readonly provider: ProviderKind;
  readonly executable: string;
  readonly checkedAt: string;
  readonly timeoutMs: number;
  readonly messages: CliVersionProbeMessages;
  readonly isCommandMissingCause: (error: unknown) => boolean;
  readonly runVersionCommand: Effect.Effect<CommandResult, unknown, R>;
}): Effect.Effect<CliVersionProbeSuccess | CliVersionProbeFailure, never, R> {
  return input.runVersionCommand.pipe(
    Effect.timeoutOption(input.timeoutMs),
    Effect.result,
    Effect.map((versionProbe): CliVersionProbeSuccess | CliVersionProbeFailure => {
      if (Result.isFailure(versionProbe)) {
        const error = versionProbe.failure;
        return {
          ok: false,
          status: {
            provider: input.provider,
            status: "error",
            available: false,
            authStatus: "unknown",
            checkedAt: input.checkedAt,
            message: input.isCommandMissingCause(error)
              ? input.messages.notInstalled
              : `${input.messages.failedToExecute}${error instanceof Error ? error.message : String(error)}.`,
          },
        };
      }

      if (Option.isNone(versionProbe.success)) {
        return {
          ok: false,
          status: {
            provider: input.provider,
            status: "error",
            available: false,
            authStatus: "unknown",
            checkedAt: input.checkedAt,
            message: input.messages.timedOut,
          },
        };
      }

      const version = versionProbe.success.value;
      if (version.code !== 0) {
        const detail = detailFromResult(version);
        return {
          ok: false,
          status: {
            provider: input.provider,
            status: "error",
            available: false,
            authStatus: "unknown",
            checkedAt: input.checkedAt,
            message: detail
              ? `${input.messages.failedToRunPrefix} ${detail}`
              : input.messages.failedToRunPrefix.trimEnd(),
          },
        };
      }

      return {
        ok: true,
        version,
        parsedVersion: parseGenericCliVersion(`${version.stdout}\n${version.stderr}`),
        checkedAt: input.checkedAt,
      };
    }),
  );
}

export function makeAuthProbeUnavailableStatus(input: {
  readonly provider: ProviderKind;
  readonly parsedVersion: string | undefined;
  readonly checkedAt: string;
  readonly message: string;
  readonly status?: "warning";
  readonly available?: true;
  readonly authStatus?: ServerProviderAuthStatus;
}): ServerProviderStatus {
  return {
    provider: input.provider,
    status: input.status ?? "warning",
    available: input.available ?? true,
    authStatus: input.authStatus ?? "unknown",
    version: input.parsedVersion,
    checkedAt: input.checkedAt,
    message: input.message,
  };
}

export function authProbeFailureMessage(prefix: string, error: unknown): string {
  return error instanceof Error ? `${prefix}: ${error.message}.` : `${prefix}.`;
}
