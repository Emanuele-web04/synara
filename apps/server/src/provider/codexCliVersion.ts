const CODEX_VERSION_PATTERN = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/;

// 0.105.0 is the first stable Codex release that honors CODEX_SQLITE_HOME.
// Account overlays rely on that routing to keep versioned continuation DBs
// shared at the source CODEX_HOME instead of creating account-local databases.
export const MINIMUM_CODEX_CLI_VERSION = "0.105.0";
export const CODEX_CLI_UNPARSEABLE_VERSION_MESSAGE = `Codex CLI version check succeeded but returned an unrecognized version. Synara requires a verifiable v${MINIMUM_CODEX_CLI_VERSION} or newer installation; upgrade or reinstall Codex and restart Synara.`;

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string>;
}

function normalizeCodexVersion(version: string): string {
  const [main, prerelease] = version.trim().split("-", 2);
  const segments = (main ?? "")
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 2) {
    segments.push("0");
  }

  return prerelease ? `${segments.join(".")}-${prerelease}` : segments.join(".");
}

function parseSemver(version: string): ParsedSemver | null {
  const normalized = normalizeCodexVersion(version);
  const [main = "", prerelease] = normalized.split("-", 2);
  const segments = main.split(".");
  if (segments.length !== 3) {
    return null;
  }

  const [majorSegment, minorSegment, patchSegment] = segments;
  if (majorSegment === undefined || minorSegment === undefined || patchSegment === undefined) {
    return null;
  }

  const major = Number.parseInt(majorSegment, 10);
  const minor = Number.parseInt(minorSegment, 10);
  const patch = Number.parseInt(patchSegment, 10);
  if (![major, minor, patch].every(Number.isInteger)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease:
      prerelease
        ?.split(".")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0) ?? [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left.localeCompare(right);
}

export function compareCodexCliVersions(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }
  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch - parsedRight.patch;
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) {
    return 0;
  }
  if (parsedLeft.prerelease.length === 0) {
    return 1;
  }
  if (parsedRight.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

export function parseCodexCliVersion(output: string): string | null {
  const match = CODEX_VERSION_PATTERN.exec(output);
  if (!match?.[1]) {
    return null;
  }

  const parsed = parseSemver(match[1]);
  if (!parsed) {
    return null;
  }

  return normalizeCodexVersion(match[1]);
}

export function isCodexCliVersionSupported(version: string): boolean {
  return compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) >= 0;
}

export function formatCodexCliUpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Codex CLI ${versionLabel} is too old for Synara. Upgrade to v${MINIMUM_CODEX_CLI_VERSION} or newer and restart Synara.`;
}
