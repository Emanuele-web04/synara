import { readFileSync } from "node:fs";

export interface LinuxDistribution {
  /** Exact os-release ID. ID_LIKE is deliberately not used for compatibility. */
  readonly id: string;
  readonly versionId?: string;
  readonly versionCodename?: string;
}

export type KWinPrebuiltBuiltOn =
  | "fedora-43"
  | "fedora-44"
  | "debian-trixie"
  | "ubuntu-2604"
  | "opensuse-tumbleweed"
  | "arch";

export type ReadOsRelease = (path: string) => string | undefined;

const OS_RELEASE_PATHS = ["/etc/os-release", "/usr/lib/os-release"] as const;

function decodeOsReleaseValue(raw: string): string | undefined {
  if (raw === "") return "";
  const quote = raw[0];
  if (quote === "'" || quote === '"') {
    if (raw.at(-1) !== quote) return undefined;
    const inner = raw.slice(1, -1);
    if (quote === "'") return inner;
    return inner.replace(/\\([\\"$`])/g, "$1");
  }
  return raw.replace(/\\(.)/g, "$1");
}

/** Parse os-release as data. This never evaluates or sources its shell-like syntax. */
export function parseLinuxDistribution(contents: string): LinuxDistribution | undefined {
  const fields = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match?.[1] || match[2] === undefined) continue;
    const decoded = decodeOsReleaseValue(match[2]);
    if (decoded !== undefined) fields.set(match[1], decoded);
  }

  const id = fields.get("ID")?.trim();
  if (!id) return undefined;
  const versionId = fields.get("VERSION_ID")?.trim() || undefined;
  const versionCodename = fields.get("VERSION_CODENAME")?.trim() || undefined;
  return {
    id,
    ...(versionId ? { versionId } : {}),
    ...(versionCodename ? { versionCodename } : {}),
  };
}

function readOsReleaseFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

let cachedDistribution: LinuxDistribution | undefined;
let defaultDetectionComplete = false;

/**
 * Detect the host distribution from os-release. Injected readers bypass the
 * process cache, which keeps tests and callers with alternate roots deterministic.
 */
export function detectLinuxDistribution(
  readOsRelease: ReadOsRelease = readOsReleaseFile,
): LinuxDistribution | undefined {
  if (readOsRelease === readOsReleaseFile && defaultDetectionComplete) return cachedDistribution;

  let detected: LinuxDistribution | undefined;
  for (const path of OS_RELEASE_PATHS) {
    const contents = readOsRelease(path);
    if (contents === undefined) continue;
    detected = parseLinuxDistribution(contents);
    // A readable /etc/os-release overrides /usr/lib even when malformed.
    break;
  }

  if (readOsRelease === readOsReleaseFile) {
    cachedDistribution = detected;
    defaultDetectionComplete = true;
  }
  return detected;
}

/** Map only distro releases represented by the prebuild matrix. */
export function prebuiltBuiltOnForDistribution(
  distribution: LinuxDistribution | undefined,
): KWinPrebuiltBuiltOn | undefined {
  if (!distribution) return undefined;
  const id = distribution.id.toLowerCase();
  const versionId = distribution.versionId?.toLowerCase();
  const versionCodename = distribution.versionCodename?.toLowerCase();
  if (id === "fedora" && versionId === "43") return "fedora-43";
  if (id === "fedora" && versionId === "44") return "fedora-44";
  if (id === "debian" && versionId === "13" && versionCodename === "trixie") {
    return "debian-trixie";
  }
  if (id === "ubuntu" && versionId === "26.04") return "ubuntu-2604";
  if (id === "opensuse-tumbleweed") return "opensuse-tumbleweed";
  if (id === "arch") return "arch";
  return undefined;
}

/** Stable, line-safe identity for install stamps and exact upgrade checks. */
export function linuxDistributionIdentity(
  distribution: LinuxDistribution | undefined,
): string | undefined {
  if (!distribution) return undefined;
  return [distribution.id, distribution.versionId ?? "", distribution.versionCodename ?? ""]
    .map(encodeURIComponent)
    .join(":");
}
