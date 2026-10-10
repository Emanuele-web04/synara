export function serializeReleaseGithubOutput(output: Readonly<Record<string, string>>): string {
  return `${Object.entries(output)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}
