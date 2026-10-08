#!/usr/bin/env node
// Verifies a same-run packaged artifact before retryable platform qualification.
import { verifyReleaseArtifactCheckpoint } from "./lib/release-artifact-checkpoint.ts";

const values = new Map<string, string>();
const known = new Set([
  "--assets-dir",
  "--platform",
  "--arch",
  "--target",
  "--version",
  "--flavor",
  "--source-commit",
  "--source-tag",
  "--lockfile-sha256",
  "--publication",
  "--allow-unsigned-windows-publication",
  "--expected-mac-team-id",
  "--expected-windows-publisher",
]);
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!name || !known.has(name) || value === undefined || values.has(name)) {
    throw new Error(`Invalid checkpoint argument: ${name ?? "<end>"}.`);
  }
  values.set(name, value);
}
function required(name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing checkpoint argument: ${name}.`);
  return value;
}
function boolean(name: string): boolean {
  const value = required(name);
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false.`);
  return value === "true";
}
const platform = required("--platform");
const flavor = required("--flavor");
if (platform !== "mac" && platform !== "win" && platform !== "linux") {
  throw new Error(`Unsupported checkpoint platform: ${platform}.`);
}
if (flavor !== "production" && flavor !== "beta") {
  throw new Error(`Unsupported checkpoint flavor: ${flavor}.`);
}
await verifyReleaseArtifactCheckpoint({
  assetsDirectory: required("--assets-dir"),
  platform,
  arch: required("--arch"),
  target: required("--target"),
  version: required("--version"),
  flavor,
  sourceCommit: required("--source-commit"),
  sourceTag: values.get("--source-tag") || null,
  lockfileSha256: required("--lockfile-sha256"),
  publication: boolean("--publication"),
  allowUnsignedWindowsPublication: boolean("--allow-unsigned-windows-publication"),
  ...(values.get("--expected-mac-team-id")
    ? { expectedMacTeamId: values.get("--expected-mac-team-id")! }
    : {}),
  ...(values.get("--expected-windows-publisher")
    ? { expectedWindowsPublisher: values.get("--expected-windows-publisher")! }
    : {}),
});
console.log(`Verified ${platform} ${required("--arch")} release checkpoint.`);
