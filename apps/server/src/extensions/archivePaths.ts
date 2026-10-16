import { extensionArchivePath } from "./manifest";

/** Linear in total path segments, including implicit directory collisions. */
export class ExtensionArchivePaths {
  private readonly paths = new Map<
    string,
    { name: string; directory: boolean; explicit: boolean }
  >();
  private characters = 0;

  add(value: string, directory: boolean): string {
    const name = extensionArchivePath(value);
    this.characters += name.length;
    if (this.characters > 4_000_000) throw new Error("VSIX path metadata exceeds the size limit.");
    const segments = name.split("/");
    let prefix = "";
    for (let index = 0; index < segments.length; index++) {
      prefix = prefix ? `${prefix}/${segments[index]}` : segments[index]!;
      const last = index === segments.length - 1;
      const isDirectory = !last || directory;
      const key = prefix.normalize("NFC").toLowerCase();
      const existing = this.paths.get(key);
      if (existing) {
        if (
          existing.name !== prefix ||
          existing.directory !== isDirectory ||
          (last && existing.explicit)
        ) {
          throw new Error("VSIX contains duplicate, conflicting or case-colliding paths.");
        }
        if (last) existing.explicit = true;
      } else {
        this.paths.set(key, { name: prefix, directory: isDirectory, explicit: last });
        if (this.paths.size > 100_000) throw new Error("VSIX contains too many path segments.");
      }
    }
    return name;
  }
}
