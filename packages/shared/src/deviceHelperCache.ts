/** the helper links private frameworks whose symbols move between Xcode releases — the cache is keyed on toolchain + source digest; one derivation shared by the backend and the smoke CLI (they previously disagreed and rebuilt from scratch) */

/** `~/Library/Caches/synara/device-helper` — callers pass their own home dir */
export const DEVICE_HELPER_CACHE_SEGMENTS = [
  "Library",
  "Caches",
  "synara",
  "device-helper",
] as const;

export const DEVICE_HELPER_BINARY_NAME = "synara-device-helper";

export const DEVICE_HELPER_SOURCE_DIR_ENV = "SYNARA_DEVICE_HELPER_SOURCE_DIR";

/** both fields included: the marketing version makes a stale cache dir legible; null when unrecognizable so callers report a setup problem */
export function deviceHelperCacheKey(
  xcodebuildVersionOutput: string,
  sourceRevision?: string,
): string | null {
  const version = /Xcode\s+([\d.]+)/u.exec(xcodebuildVersionOutput)?.[1];
  const build = /Build version\s+(\S+)/u.exec(xcodebuildVersionOutput)?.[1];
  if (!version && !build) return null;
  const toolchain = `${version ?? "unknown"}-${build ?? "unknown"}`;
  return sourceRevision ? `${toolchain}-${sourceRevision}` : toolchain;
}

/** toolchain alone isn't enough — a shipped helper fix must invalidate the cache like an Xcode upgrade does */
export interface DeviceHelperSourceFile {
  readonly name: string;
  readonly contents: string;
}

export function deviceHelperSourceRevision(files: readonly DeviceHelperSourceFile[]): string {
  // name + contents so a rename is a change; sorted so directory order can't hash two ways
  const canonical = [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((file) => `${file.name}\0${file.contents}`)
    .join("\0");

  // FNV-1a: no crypto import in a browser-shared package; collisions only cost a missed rebuild
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** `readSourceFile` injected so this module stays free of Node imports and browser-importable */
export async function readDeviceHelperSourceRevision(
  helperSourceDir: string,
  io: {
    readonly listSources: (dir: string) => Promise<readonly string[]>;
    readonly readFile: (file: string) => Promise<string>;
    readonly join: (...parts: string[]) => string;
  },
): Promise<string | undefined> {
  const sourcesDir = io.join(helperSourceDir, "Sources");
  const names = await io.listSources(sourcesDir).catch(() => null);
  if (names === null) return undefined;

  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      contents: await io.readFile(io.join(sourcesDir, name)).catch(() => ""),
    })),
  );
  // build.sh drives the compile — a change to it changes the binary too
  const script = await io.readFile(io.join(helperSourceDir, "build.sh")).catch(() => "");
  return deviceHelperSourceRevision([...files, { name: "build.sh", contents: script }]);
}
