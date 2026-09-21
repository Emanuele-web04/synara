// FILE: desktop-artifact-names.ts
// Purpose: Canonical electron-builder artifact name template shared by packaging and Homebrew.
// Layer: Release/build helper

export const DESKTOP_ARTIFACT_NAME_TEMPLATE = "Synara-${version}-${arch}.${ext}";

export function desktopArtifactFileName(input: {
  readonly version: string;
  readonly arch: "arm64" | "x64";
  readonly ext: string;
}): string {
  return DESKTOP_ARTIFACT_NAME_TEMPLATE.replace("${version}", input.version)
    .replace("${arch}", input.arch)
    .replace("${ext}", input.ext);
}
