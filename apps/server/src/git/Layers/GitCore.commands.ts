// FILE: GitCore.commands.ts
// Purpose: Pure command-label, path, and GitCommandError construction helpers for the GitCore service.
// Layer: Server Git service (pure)
// Exports: command/error builders, path/error-code predicates, and the trace2 record schema.
import { Schema } from "effect";
import * as nodePath from "node:path";

import { GitCommandError } from "../Errors.ts";
import type { ExecuteGitInput } from "../Services/GitCore.ts";
import { parseDirtyWorktreeFiles } from "./GitCore.parsing.ts";

export function resolveGitPath(cwd: string, gitPath: string): string {
  return nodePath.isAbsolute(gitPath) ? gitPath : nodePath.join(cwd, gitPath);
}

export function hasNodeErrorCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === code
  );
}

export function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

export function quoteGitCommand(args: ReadonlyArray<string>): string {
  return `git ${args.join(" ")}`;
}

export function isMissingGitCwdError(error: GitCommandError): boolean {
  const normalized = `${error.detail}\n${error.message}`.toLowerCase();
  return (
    normalized.includes("no such file or directory") ||
    normalized.includes("notfound: filesystem.access") ||
    normalized.includes("enoent") ||
    normalized.includes("not a directory")
  );
}

export function createGitCommandError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export function toGitCommandError(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  detail: string,
) {
  return (cause: unknown) =>
    Schema.is(GitCommandError)(cause)
      ? cause
      : new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${cause instanceof Error && cause.message.length > 0 ? cause.message : "Unknown error"} - ${detail}`,
          ...(cause !== undefined ? { cause } : {}),
        });
}

export function explainPullBlockedByLocalChanges(error: GitCommandError): string | null {
  const files = parseDirtyWorktreeFiles(error.detail);
  if (!files) return null;
  const fileList = files.map((file) => `  - ${file}`).join("\n");
  return `Local changes block pull. Commit or stash these files first:\n${fileList}`;
}

export const Trace2Record = Schema.Record(Schema.String, Schema.Unknown);
