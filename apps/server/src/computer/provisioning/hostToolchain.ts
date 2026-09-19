/**
 * The Qt and KDE Frameworks versions installed on this host, read off disk.
 *
 * A KWin plugin built on one distribution loads on another only when the
 * libraries it was linked against are the same versions there: the KWin
 * version is checked first and exactly, but two distributions can ship the
 * same KWin on different Qt or KF releases, and a plugin built against the
 * wrong ones fails at load with nothing more than `false` from KWin. So a
 * cross-distribution prebuilt is accepted only when both versions match the
 * ones recorded at build time, and this is the one place they are read.
 *
 * Reading them costs no process: the cmake package version files every
 * distribution installs with the development packages carry the version, and
 * when those are absent (a machine with the runtime but not the -devel
 * packages) the versioned soname of the library itself does.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface HostToolchainVersions {
  readonly qtVersion: string | undefined;
  readonly kfVersion: string | undefined;
}

/** Test seam over the two filesystem reads this module makes. */
export interface HostToolchainReaders {
  readonly readFile: (path: string) => string | undefined;
  readonly listDirectory: (path: string) => readonly string[];
}

/** The library roots the distributions in the prebuild matrix use, in probe order. */
export const HOST_LIBRARY_ROOTS = [
  "/usr/lib64",
  "/usr/lib",
  "/usr/lib/x86_64-linux-gnu",
  "/usr/lib/aarch64-linux-gnu",
] as const;

const PACKAGE_VERSION = /set\(PACKAGE_VERSION "([0-9]+(?:\.[0-9]+)+)"\)/;

interface ToolchainComponent {
  /** The cmake package whose `<name>ConfigVersion.cmake` names the version. */
  readonly cmakePackage: string;
  /** The library whose versioned soname names it when the config is absent. */
  readonly libraryPattern: RegExp;
}

const QT: ToolchainComponent = {
  cmakePackage: "Qt6",
  libraryPattern: /^libQt6Core\.so\.([0-9]+\.[0-9]+\.[0-9]+)$/,
};

const KF: ToolchainComponent = {
  cmakePackage: "KF6WindowSystem",
  libraryPattern: /^libKF6WindowSystem\.so\.([0-9]+\.[0-9]+\.[0-9]+)$/,
};

export const defaultHostToolchainReaders: HostToolchainReaders = {
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  listDirectory: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

function componentVersion(
  component: ToolchainComponent,
  readers: HostToolchainReaders,
): string | undefined {
  for (const root of HOST_LIBRARY_ROOTS) {
    const config = readers.readFile(
      join(root, "cmake", component.cmakePackage, `${component.cmakePackage}ConfigVersion.cmake`),
    );
    const fromConfig = config === undefined ? undefined : PACKAGE_VERSION.exec(config)?.[1];
    if (fromConfig) return fromConfig;
  }
  for (const root of HOST_LIBRARY_ROOTS) {
    for (const name of readers.listDirectory(root)) {
      const match = component.libraryPattern.exec(name);
      if (match?.[1]) return match[1];
    }
  }
  return undefined;
}

/** Both versions, each undefined when neither its config nor its library is on disk. */
export function readHostToolchainVersions(
  readers: HostToolchainReaders = defaultHostToolchainReaders,
): HostToolchainVersions {
  return {
    qtVersion: componentVersion(QT, readers),
    kfVersion: componentVersion(KF, readers),
  };
}
