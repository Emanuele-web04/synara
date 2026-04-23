export function isWindowsShellCommandMissingResult(input: {
  readonly code: number;
  readonly stderr: string;
  readonly platform?: NodeJS.Platform;
}): boolean {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return false;
  }

  if (input.code === 9009) {
    return true;
  }

  return /is not recognized as an internal or external command/i.test(input.stderr);
}
