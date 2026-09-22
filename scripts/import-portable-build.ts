import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PORTABLE_BUILD_ROOTS, verifyPortableBuild } from "./lib/portable-build.ts";
import { assertPortableArchiveEntries } from "./lib/portable-build-archive.ts";
import { timeBuildStage } from "./lib/build-timing.ts";

const [directory, sourceCommit] = process.argv.slice(2);
if (!directory || !sourceCommit)
  throw new Error("Usage: import-portable-build.ts ARTIFACT_DIRECTORY SOURCE_COMMIT");
const archive = resolve(directory, "outputs.tar");
const runTar = (args: string[]) => {
  const result = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0)
    throw new Error(`Portable archive failed: ${result.stderr || result.error?.message}`);
  return result.stdout.trimEnd().split(/\r?\n/);
};
timeBuildStage("portable-build-import", () => {
  assertPortableArchiveEntries(
    runTar(["-tf", archive]),
    runTar(["-tvf", archive]).map((line) => line[0] ?? ""),
  );
  const stage = mkdtempSync(join(tmpdir(), "synara-portable-"));
  try {
    runTar(["-xf", archive, "-C", stage]);
    verifyPortableBuild(
      stage,
      sourceCommit,
      JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8")),
      process.env,
      process.cwd(),
    );
    for (const root of PORTABLE_BUILD_ROOTS) {
      rmSync(root, { recursive: true, force: true });
      cpSync(join(stage, root), root, { recursive: true });
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
