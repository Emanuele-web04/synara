import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export function assertLinuxPackageArchiveEntries(
  names: ReadonlyArray<string>,
  types: ReadonlyArray<string>,
  label: string,
): void {
  if (names.length === 0 || names.length !== types.length)
    throw new Error(`Invalid ${label} payload archive inventory.`);
  const seen = new Set<string>();
  for (let index = 0; index < names.length; index++) {
    const name = names[index]!;
    const path = name.replace(/^\.\//, "").replace(/\/$/, "");
    const type = types[index];
    if (type !== "-" && type !== "d")
      throw new Error(`${label} payload may contain only files and directories: ${name}.`);
    if ((name === "." || name === "./") && type === "d") continue;
    if (
      name.startsWith("/") ||
      /[\\\p{Cc}]/u.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Unsafe ${label} payload archive entry: ${name}.`);
    }
    if (seen.has(path)) throw new Error(`Duplicate ${label} payload archive entry: ${name}.`);
    seen.add(path);
  }
}

/** Inspect rpm2cpio's newc headers before cpio can create paths in the owned tree. */
export function assertRpmCpioArchive(archive: string): void {
  const descriptor = openSync(archive, "r");
  try {
    const size = fstatSync(descriptor).size;
    const names: string[] = [];
    const types: string[] = [];
    const kinds = new Map<string, number>();
    const buildIdLinks = new Map<string, string>();
    const read = (position: number, length: number): Buffer => {
      if (position + length > size) throw new Error("Truncated RPM payload archive.");
      const buffer = Buffer.alloc(length);
      if (readSync(descriptor, buffer, 0, length, position) !== length)
        throw new Error("Truncated RPM payload archive.");
      return buffer;
    };
    let position = 0;
    let trailer = false;
    while (position < size) {
      const header = read(position, 110).toString("ascii");
      if (!/^07070[12][0-9a-fA-F]{104}$/.test(header))
        throw new Error("Unsupported RPM payload archive header.");
      const field = (index: number) =>
        Number.parseInt(header.slice(6 + index * 8, 14 + index * 8), 16);
      const mode = field(1);
      const linkCount = field(4);
      const fileSize = field(6);
      const nameSize = field(11);
      if (nameSize < 2 || nameSize > 4096) throw new Error("Invalid RPM archive entry name size.");
      const nameBytes = read(position + 110, nameSize);
      if (nameBytes[nameSize - 1] !== 0) throw new Error("Invalid RPM archive entry name.");
      const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes.subarray(0, -1));
      const dataPosition = Math.ceil((position + 110 + nameSize) / 4) * 4;
      const end = Math.ceil((dataPosition + fileSize) / 4) * 4;
      if (end > size) throw new Error("Truncated RPM payload archive.");
      position = end;
      if (name === "TRAILER!!!") {
        if (fileSize !== 0) throw new Error("Invalid RPM archive trailer.");
        trailer = true;
        break;
      }
      const kind = mode & 0o170000;
      const path = name.replace(/^\.\//, "").replace(/\/$/, "");
      // rpmbuild adds SHA-1 build-id links for packaged ELF binaries. Keep the
      // application payload file-only and inspect these metadata links before
      // extraction: their targets must be regular files in this same archive.
      const isBuildIdLink =
        kind === 0o120000 && /^usr\/lib\/\.build-id\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(path);
      if (kind !== 0o040000 && kind !== 0o100000 && !isBuildIdLink)
        throw new Error(`RPM payload may contain only files and directories: ${name}.`);
      if ((kind === 0o100000 || isBuildIdLink) && linkCount !== 1)
        throw new Error(`RPM payload must not contain hard links: ${name}.`);
      if (kind === 0o040000 && fileSize !== 0)
        throw new Error(`RPM directory entry contains data: ${name}.`);
      if (isBuildIdLink) {
        if (fileSize < 1 || fileSize > 4096)
          throw new Error(`Invalid RPM build-id link size: ${name}.`);
        const target = new TextDecoder("utf-8", { fatal: true }).decode(
          read(dataPosition, fileSize),
        );
        if (target.startsWith("/") || /[\\\p{Cc}]/u.test(target))
          throw new Error(`Unsafe RPM build-id link target: ${name}.`);
        buildIdLinks.set(path, target);
      }
      names.push(name);
      types.push(kind === 0o040000 ? "d" : "-");
      kinds.set(path, kind);
      if (names.length > 100_000) throw new Error("RPM payload archive has too many entries.");
    }
    if (!trailer) throw new Error("RPM payload archive is missing its trailer.");
    while (position < size) {
      const padding = read(position, Math.min(size - position, 4096));
      if (padding.some((byte) => byte !== 0))
        throw new Error("Unexpected data after RPM archive trailer.");
      position += padding.length;
    }
    assertLinuxPackageArchiveEntries(names, types, "RPM");
    for (const path of kinds.keys()) {
      const parents = path.split("/");
      parents.pop();
      while (parents.length > 0) {
        const parentKind = kinds.get(parents.join("/"));
        if (parentKind !== undefined && parentKind !== 0o040000)
          throw new Error(`RPM archive path traverses a non-directory: ${path}.`);
        parents.pop();
      }
    }
    for (const [path, target] of buildIdLinks) {
      const resolved = path.split("/");
      resolved.pop();
      for (const part of target.split("/")) {
        if (part === ".") continue;
        if (part === "..") {
          if (resolved.length === 0)
            throw new Error(`RPM build-id link escapes the archive: ${path}.`);
          resolved.pop();
        } else {
          if (!part) throw new Error(`Unsafe RPM build-id link target: ${path}.`);
          resolved.push(part);
        }
      }
      const destination = resolved.join("/");
      if (!destination.startsWith("opt/") || kinds.get(destination) !== 0o100000)
        throw new Error(`RPM build-id link must target an archived application file: ${path}.`);
    }
  } finally {
    closeSync(descriptor);
  }
}
