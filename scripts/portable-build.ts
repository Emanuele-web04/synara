import { readFileSync, writeFileSync } from "node:fs";
import { portableBuildManifest, verifyPortableBuild } from "./lib/portable-build.ts";
import { timeBuildStage } from "./lib/build-timing.ts";

const [mode, manifestPath, sourceCommit] = process.argv.slice(2);
if (!manifestPath || !sourceCommit || !["create", "verify"].includes(mode ?? "")) {
  throw new Error("Usage: node scripts/portable-build.ts create|verify MANIFEST SOURCE_COMMIT");
}
timeBuildStage(`portable-build-${mode}`, () => {
  if (mode === "create")
    writeFileSync(
      manifestPath,
      JSON.stringify(portableBuildManifest(process.cwd(), sourceCommit)) + "\n",
    );
  else
    verifyPortableBuild(
      process.cwd(),
      sourceCommit,
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
});
