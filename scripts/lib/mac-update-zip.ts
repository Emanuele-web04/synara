// FILE: mac-update-zip.ts
// Purpose: Validates and patches macOS update zip metadata before release publish.
// Layer: Release/build helper
// Exports: macOS zip symlink checks and latest-mac.yml update helpers.

export const MAC_UPDATE_ZIP_FRAMEWORK_SYMLINK_SUFFIXES = [
  "Contents/Frameworks/Electron Framework.framework/Electron Framework",
  "Contents/Frameworks/Electron Framework.framework/Helpers",
  "Contents/Frameworks/Electron Framework.framework/Libraries",
  "Contents/Frameworks/Electron Framework.framework/Resources",
  "Contents/Frameworks/Electron Framework.framework/Versions/Current",
] as const;

export interface MacUpdateZipMetadata {
  readonly sha512: string;
  readonly size: number;
}

export interface MacUpdateManifestZipValidation {
  readonly manifestHasZipPath: boolean;
  readonly manifestHasZipSha: boolean;
  readonly manifestHasZipSize: boolean;
}

// The Electron framework must keep these symlinks inside the update zip; if a
// zip tool dereferences them, Squirrel.Mac rejects the extracted app signature.
export function buildMacUpdateZipSymlinkEntries(appBundleName: string): ReadonlyArray<string> {
  return MAC_UPDATE_ZIP_FRAMEWORK_SYMLINK_SUFFIXES.map((suffix) => `${appBundleName}/${suffix}`);
}

export function resolveSingleMacUpdateZipFileName(entries: ReadonlyArray<string>): string {
  const zipFileNames = entries.filter((entry) => entry.endsWith(".zip"));
  if (zipFileNames.length !== 1 || !zipFileNames[0]) {
    throw new Error(`Expected one macOS update zip artifact, found ${zipFileNames.length}.`);
  }
  return zipFileNames[0];
}

export function resolveMacUpdateManifestFileNames(entries: ReadonlyArray<string>): string[] {
  const manifestFileNames = entries.filter((entry) => entry.endsWith("-mac.yml"));
  if (manifestFileNames.length === 0) {
    throw new Error("Expected at least one macOS update manifest, found 0.");
  }
  return manifestFileNames;
}

export function parseZipInfoUnixAttributes(zipInfoOutput: string): string | null {
  const match = zipInfoOutput.match(/Unix file attributes \([^)]+\):\s*([^\r\n]+)/);
  return match?.[1]?.trim() ?? null;
}

export function isZipInfoSymlink(zipInfoOutput: string): boolean {
  return parseZipInfoUnixAttributes(zipInfoOutput)?.startsWith("l") ?? false;
}

export function resolveSingleTopLevelMacAppBundle(entries: ReadonlyArray<string>): string {
  const appBundleNames = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith("__MACOSX/")) {
      continue;
    }
    const match = entry.match(/^([^/]+\.app)\//);
    if (match?.[1]) {
      appBundleNames.add(match[1]);
    }
  }

  if (appBundleNames.size !== 1) {
    throw new Error(
      `Expected one top-level .app bundle in macOS update zip, found ${appBundleNames.size}.`,
    );
  }

  const appBundleName = [...appBundleNames][0];
  if (!appBundleName) {
    throw new Error("Expected one top-level .app bundle in macOS update zip.");
  }
  return appBundleName;
}

function stripYamlSingleQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function parseYamlScalarFromLine(line: string, key: string): string | null {
  const match = line.match(new RegExp(`^${key}:\\s*(.+)$`));
  return match?.[1] ? stripYamlSingleQuotes(match[1]) : null;
}

export function updateMacUpdateManifestZipEntry(
  manifest: string,
  zipFileName: string,
  metadata: MacUpdateZipMetadata,
): string {
  const lines = manifest.split(/\r?\n/);
  let inTargetFile = false;
  let targetFileFound = false;
  let targetShaUpdated = false;
  let targetSizeUpdated = false;
  let topLevelPathMatches = false;
  let matchingTopLevelPathFound = false;
  let topLevelShaUpdated = false;

  const nextLines = lines.flatMap((line) => {
    const fileUrlMatch = line.match(/^  - url:\s*(.+)$/);
    if (fileUrlMatch?.[1]) {
      inTargetFile = stripYamlSingleQuotes(fileUrlMatch[1]) === zipFileName;
      if (inTargetFile) {
        targetFileFound = true;
      }
      return [line];
    }

    if (inTargetFile && line.match(/^    sha512:\s*.+$/)) {
      targetShaUpdated = true;
      return [`    sha512: ${metadata.sha512}`];
    }

    if (inTargetFile && line.match(/^    size:\s*\d+$/)) {
      targetSizeUpdated = true;
      return [`    size: ${metadata.size}`];
    }

    // Drop the repacked zip's stale blockMapSize: finalize removes the matching
    // .zip.blockmap after repack, so the manifest must not keep advertising it.
    if (inTargetFile && line.match(/^    blockMapSize:\s*\d+$/)) {
      return [];
    }

    const topLevelPath = parseYamlScalarFromLine(line, "path");
    if (topLevelPath !== null) {
      topLevelPathMatches = topLevelPath === zipFileName;
      if (topLevelPathMatches) {
        matchingTopLevelPathFound = true;
      }
      return [line];
    }

    if (topLevelPathMatches && line.match(/^sha512:\s*.+$/)) {
      topLevelShaUpdated = true;
      topLevelPathMatches = false;
      return [`sha512: ${metadata.sha512}`];
    }

    return [line];
  });

  if (!targetFileFound || !targetShaUpdated || !targetSizeUpdated) {
    throw new Error(`Could not update ${zipFileName} entry in macOS update manifest.`);
  }

  if (matchingTopLevelPathFound && !topLevelShaUpdated) {
    throw new Error(
      `Could not update top-level sha512 for ${zipFileName} in macOS update manifest.`,
    );
  }

  return nextLines.join("\n");
}

export function validateMacUpdateManifestZipMetadata(
  manifest: string,
  zipFileName: string,
  metadata: MacUpdateZipMetadata,
): MacUpdateManifestZipValidation {
  return {
    manifestHasZipPath: manifest.includes(zipFileName),
    manifestHasZipSha: manifest.includes(`sha512: ${metadata.sha512}`),
    manifestHasZipSize: manifest.includes(`size: ${metadata.size}`),
  };
}

export function assertMacUpdateManifestZipMetadata(
  manifest: string,
  zipFileName: string,
  metadata: MacUpdateZipMetadata,
): MacUpdateManifestZipValidation {
  const validation = validateMacUpdateManifestZipMetadata(manifest, zipFileName, metadata);
  if (
    !validation.manifestHasZipPath ||
    !validation.manifestHasZipSha ||
    !validation.manifestHasZipSize
  ) {
    throw new Error(`macOS update manifest does not match ${zipFileName} metadata.`);
  }
  return validation;
}
