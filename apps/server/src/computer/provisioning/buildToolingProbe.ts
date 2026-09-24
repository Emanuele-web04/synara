/**
 * The primitives behind the "could this machine build the plugin from source"
 * probes of the KWin and Hyprland backends.
 *
 * Those probes run inside availability checks that must stay free, so every
 * question here is answered with plain existence checks against the places a
 * compiler, cmake or pkg-config would look: no process, no file read. They are
 * not a build attempt and can still be fooled by a broken install, but they
 * name the files a configure step actually fails on, so a machine missing a
 * header is reported as unable to build instead of failing seconds into
 * setup.
 */
import { join } from "node:path";

import { HOST_LIBRARY_ROOTS } from "./hostToolchain.ts";

export type PathExists = (path: string) => boolean;

/** Where the compiler finds system headers without any extra `-I`. */
const SYSTEM_INCLUDE_ROOTS = ["/usr/include", "/usr/local/include"] as const;

/**
 * pkg-config's compiled-in search path across the distributions the plugins
 * are built on: each library root's `pkgconfig`, the arch-independent share
 * directory, and the /usr/local twins.
 */
const DEFAULT_PKG_CONFIG_DIRECTORIES = [
  ...HOST_LIBRARY_ROOTS.map((root) => join(root, "pkgconfig")),
  "/usr/share/pkgconfig",
  "/usr/local/lib/pkgconfig",
  "/usr/local/lib64/pkgconfig",
  "/usr/local/share/pkgconfig",
] as const;

function pathList(value: string | undefined): readonly string[] {
  return (value ?? "").split(":").filter(Boolean);
}

/** Whether any directory on `PATH` holds `command`. */
export function commandOnPath(
  command: string,
  exists: PathExists,
  env: NodeJS.ProcessEnv,
): boolean {
  return pathList(env.PATH).some((directory) => exists(join(directory, command)));
}

/** Whether `relativePath` (e.g. `vulkan/vulkan.h`) is under a system include root. */
export function systemHeaderPresent(relativePath: string, exists: PathExists): boolean {
  return SYSTEM_INCLUDE_ROOTS.some((root) => exists(join(root, relativePath)));
}

/**
 * Whether `relativePath` is under one of the library roots, which is where
 * both the `cmake/<Package>/<Package>Config.cmake` files and the unversioned
 * `lib<name>.so` development symlinks live.
 */
export function libraryRootFilePresent(relativePath: string, exists: PathExists): boolean {
  return HOST_LIBRARY_ROOTS.some((root) => exists(join(root, relativePath)));
}

/**
 * Whether pkg-config would find `<module>.pc`: `PKG_CONFIG_PATH` first, then
 * `PKG_CONFIG_LIBDIR` when it replaces the default search path, else the
 * default directories.
 */
export function pkgConfigModulePresent(
  module: string,
  exists: PathExists,
  env: NodeJS.ProcessEnv,
): boolean {
  const directories = [
    ...pathList(env.PKG_CONFIG_PATH),
    ...(env.PKG_CONFIG_LIBDIR === undefined
      ? DEFAULT_PKG_CONFIG_DIRECTORIES
      : pathList(env.PKG_CONFIG_LIBDIR)),
  ];
  return directories.some((directory) => exists(join(directory, `${module}.pc`)));
}
