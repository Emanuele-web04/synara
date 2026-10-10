const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function quotePosixShellArgument(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  if (SAFE_TOKEN_PATTERN.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
