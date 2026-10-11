// FILE: release-github-output.ts
// Purpose: Serializes release metadata for the GitHub Actions output file.
// Layer: Release script utility

export function serializeReleaseGithubOutput(output: Readonly<Record<string, string>>): string {
  return `${Object.entries(output)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}
