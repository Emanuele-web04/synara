// FILE: prepare-release-update-feed.ts
// Purpose: Prepares updater metadata for historical bridge and current Latest releases.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareReleaseUpdateManifests,
  readReleaseUpdatePolicyConfig,
} from "./lib/release-update-policy.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const channelIndex = args.indexOf("--channel");
const channelOverride = channelIndex === -1 ? undefined : args[channelIndex + 1];
if (channelIndex !== -1 && (channelOverride === undefined || channelOverride.startsWith("--"))) {
  throw new Error("Missing value for --channel.");
}
const assetArg = args.find(
  (arg, index) => index !== channelIndex && index !== channelIndex + 1 && !arg.startsWith("--"),
);
const assetDirectory = resolve(assetArg ?? "release-assets");
const prepared = prepareReleaseUpdateManifests(
  assetDirectory,
  readReleaseUpdatePolicyConfig(repoRoot),
  channelOverride,
);

console.log(`Prepared updater manifests: ${prepared.join(", ")}`);
