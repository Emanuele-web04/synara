import { PORTABLE_BUILD_ROOTS } from "./portable-build.ts";

export function assertPortableArchiveEntries(names: string[], types: string[]): void {
  for (const name of names) {
    const path = name.replace(/\/$/, "");
    if (
      !/^[a-zA-Z0-9_@+./-]+$/.test(path) ||
      path.split("/").some((part) => part === "." || part === ".." || part === "") ||
      !PORTABLE_BUILD_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
    ) {
      throw new Error(`Unsafe portable archive entry: ${name}`);
    }
  }
  if (
    names.length === 0 ||
    types.length !== names.length ||
    types.some((type) => type !== "-" && type !== "d")
  )
    throw new Error("Portable archive may contain only regular files and directories.");
}
