// Resume a retained packaging stage without rebuilding or re-signing the app.
import { finalizeSignedMacDmg } from "./lib/mac-dmg-finalize.ts";
import { finalizeMacUpdateZip } from "./lib/mac-update-zip-finalize.ts";
const [stageDistDir, mode] = process.argv.slice(2);
if (!stageDistDir || (mode !== undefined && mode !== "--dmg-only"))
  throw new Error("Usage: node scripts/finalize-mac-dmg.ts STAGE_DIST_DIRECTORY [--dmg-only]");
await finalizeSignedMacDmg({
  stageDistDir,
  appleApiKey: process.env.APPLE_API_KEY,
  appleApiKeyId: process.env.APPLE_API_KEY_ID,
  appleApiIssuer: process.env.APPLE_API_ISSUER,
  verbose: true,
});
// Release CI finalizes the update ZIP before the DMG, and smokes it meanwhile.
if (mode !== "--dmg-only")
  await finalizeMacUpdateZip({ stageDistDir, signed: true, verbose: true });
