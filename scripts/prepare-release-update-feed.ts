// FILE: prepare-release-update-feed.ts
// Purpose: Prepares updater metadata for historical bridge and current Latest releases.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareReleaseUpdateManifests,
  readReleaseUpdatePolicyConfig,
} from "./lib/release-update-policy.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyConfig = readReleaseUpdatePolicyConfig(repoRoot);
const args = process.argv.slice(2);
const channelIndex = args.indexOf("--channel");
const channelOverride = channelIndex === -1 ? undefined : args[channelIndex + 1];
if (channelIndex !== -1 && (channelOverride === undefined || channelOverride.startsWith("--"))) {
  throw new Error("Missing value for --channel.");
}
if (channelOverride !== undefined) {
  // Without this, `--channel release-assets` silently swallows the positional
  // and emits release-assets-mac.yml etc. instead of failing.
  const knownChannels = new Set([policyConfig.channel, "beta"]);
  if (!knownChannels.has(channelOverride)) {
    throw new Error(
      `Unknown update channel: ${channelOverride} (expected one of: ${[...knownChannels].join(", ")}).`,
    );
  }
}
const positionals = args.filter(
  (arg, index) =>
    !arg.startsWith("--") &&
    (channelIndex === -1 || (index !== channelIndex && index !== channelIndex + 1)),
);
if (positionals.length > 1) {
  throw new Error(`Unexpected arguments: ${positionals.slice(1).join(" ")}`);
}
const assetDirectory = resolve(positionals[0] ?? "release-assets");
const prepared = prepareReleaseUpdateManifests(assetDirectory, policyConfig, channelOverride);

console.log(`Prepared updater manifests: ${prepared.join(", ")}`);
