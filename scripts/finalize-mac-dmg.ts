// Resume a retained packaging stage without rebuilding or re-signing the app.
import { finalizeSignedMacDmg } from "./lib/mac-dmg-finalize.ts";
import { finalizeMacUpdateZip } from "./lib/mac-update-zip-finalize.ts";
const stageDistDir = process.argv[2];
if (!stageDistDir) throw new Error("Usage: node scripts/finalize-mac-dmg.ts STAGE_DIST_DIRECTORY");
await finalizeSignedMacDmg({
  stageDistDir,
  appleApiKey: process.env.APPLE_API_KEY,
  appleApiKeyId: process.env.APPLE_API_KEY_ID,
  appleApiIssuer: process.env.APPLE_API_ISSUER,
  verbose: true,
});
await finalizeMacUpdateZip({ stageDistDir, signed: true, verbose: true });
