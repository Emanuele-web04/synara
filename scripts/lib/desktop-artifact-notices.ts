import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/** Fail artifact verification unless an exact notice copy is inside app resources. */
export async function assertPackagedThirdPartyNotice(
  artifactDirectory: string,
  expectedContents: string,
): Promise<void> {
  const pending = [artifactDirectory];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory)) {
      const entryPath = join(directory, entry);
      let entryStat;
      try {
        entryStat = await stat(entryPath);
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (
        entry === "THIRD_PARTY_NOTICES.md" &&
        basename(directory).toLowerCase() === "resources" &&
        (await readFile(entryPath, "utf8")) === expectedContents
      ) {
        return;
      }
    }
  }
  throw new Error("Packaged app is missing the staged THIRD_PARTY_NOTICES.md resource.");
}
