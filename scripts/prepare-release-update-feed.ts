// FILE: prepare-release-update-feed.ts
// Purpose: Prepares default and dedicated-channel metadata for bridge and clean releases.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareReleaseUpdateManifests,
  readReleaseUpdatePolicyConfig,
} from "./lib/release-update-policy.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetDirectory = resolve(process.argv[2] ?? "release-assets");
const prepared = prepareReleaseUpdateManifests(
  assetDirectory,
  readReleaseUpdatePolicyConfig(repoRoot),
);

console.log(`Prepared updater manifests: ${prepared.join(", ")}`);
