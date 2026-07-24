export function quoteExternalMcpShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
