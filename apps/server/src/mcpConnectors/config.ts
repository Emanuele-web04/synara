import { homedir } from "node:os";
import * as Path from "node:path";
import { McpConnectorConnectInput } from "@synara/contracts";
import { Schema } from "effect";

export function normalizeConnectorInput(raw: unknown, cwd = homedir()): McpConnectorConnectInput {
  let input: McpConnectorConnectInput;
  try {
    input = Schema.decodeUnknownSync(McpConnectorConnectInput)(raw);
  } catch {
    throw new Error(
      "Provide a preset, a URL, or a name, command and argument array. Environment keys must be valid variable names.",
    );
  }
  if (!("command" in input)) return input;
  const expand = (value: string) =>
    value === "~"
      ? homedir()
      : /^~[/\\]/u.test(value)
        ? Path.join(homedir(), value.slice(2))
        : value;
  if (
    [input.command, ...input.args, input.cwd ?? "", ...Object.values(input.env ?? {})].some(
      (value) => value.includes("\0"),
    )
  )
    throw new Error("MCP process settings cannot contain NUL characters.");
  if (Object.keys(input.env ?? {}).length > 128)
    throw new Error("Use at most 128 environment variables.");
  return {
    ...input,
    command: expand(input.command),
    args: input.args.map(expand),
    cwd: Path.resolve(cwd, expand(input.cwd ?? cwd)),
  };
}
