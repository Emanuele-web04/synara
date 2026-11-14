import { callExternalMcpTool, type ExternalMcpFetch } from "./bridge.ts";

/**
 * `synara task …` is a thin terminal client of the paired external MCP
 * integration: every command is one `tools/call`, so the CLI inherits the
 * integration's project grant, scopes, rate limits and audit trail instead of
 * adding a second authority path into the server.
 */
export async function runExternalMcpToolCommand(input: {
  readonly baseDir: string;
  readonly integrationId?: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly fetchImpl?: ExternalMcpFetch;
}): Promise<{ readonly exitCode: number }> {
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  const result = await callExternalMcpTool({
    baseDir: input.baseDir,
    name: input.tool,
    arguments: input.arguments,
    ...(input.integrationId ? { integrationId: input.integrationId } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (result.isError) {
    stderr.write(`${result.text || `${input.tool} failed.`}\n`);
    return { exitCode: 1 };
  }
  // ponytail: JSON only — the main consumers are scripts and agents; add a
  // human table formatter when someone actually reads this by eye.
  stdout.write(
    result.structuredContent
      ? `${JSON.stringify(result.structuredContent, null, 2)}\n`
      : `${result.text}\n`,
  );
  return { exitCode: 0 };
}

/** Drops unset optional flags so the gateway sees only what the user passed. */
export function compactToolArguments(
  values: Record<string, string | number | boolean | Record<string, unknown> | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}
