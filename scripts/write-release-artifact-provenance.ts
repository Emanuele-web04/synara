#!/usr/bin/env node
// FILE: write-release-artifact-provenance.ts
// Purpose: CLI entrypoint for post-build release asset trust proof.
// Layer: Release verification script

import {
  type ReleaseArtifactPlatform,
  writeReleaseArtifactProvenance,
} from "./lib/release-artifact-provenance.ts";

interface CliOptions {
  readonly assetsDirectory: string;
  readonly platform: ReleaseArtifactPlatform;
  readonly arch: string;
  readonly target: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly sourceTag: string | null;
  readonly lockfileSha256: string;
  readonly publication: boolean;
  readonly signed: boolean;
  readonly expectedMacTeamId?: string;
  readonly expectedWindowsPublisher?: string;
  readonly expectedWindowsSubjectDn?: string;
}

function parseBoolean(name: string, value: string | undefined): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function parseArgs(argv: ReadonlyArray<string>): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid artifact provenance argument near ${name ?? "<end>"}.`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate artifact provenance argument: ${name}.`);
    }
    values.set(name, value);
  }

  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing artifact provenance argument: ${name}.`);
    return value;
  };
  const platform = required("--platform");
  if (platform !== "linux" && platform !== "mac" && platform !== "win") {
    throw new Error(`Unsupported artifact provenance platform: ${platform}.`);
  }

  const knownArguments = new Set([
    "--assets-dir",
    "--platform",
    "--arch",
    "--target",
    "--version",
    "--source-commit",
    "--source-tag",
    "--lockfile-sha256",
    "--publication",
    "--signed",
    "--expected-mac-team-id",
    "--expected-windows-publisher",
    "--expected-windows-subject-dn",
  ]);
  for (const name of values.keys()) {
    if (!knownArguments.has(name)) throw new Error(`Unknown artifact provenance argument: ${name}.`);
  }

  const expectedMacTeamId = values.get("--expected-mac-team-id") || undefined;
  const expectedWindowsPublisher = values.get("--expected-windows-publisher") || undefined;
  const expectedWindowsSubjectDn = values.get("--expected-windows-subject-dn") || undefined;
  return {
    assetsDirectory: required("--assets-dir"),
    platform,
    arch: required("--arch"),
    target: required("--target"),
    version: required("--version"),
    sourceCommit: required("--source-commit"),
    sourceTag: values.get("--source-tag") || null,
    lockfileSha256: required("--lockfile-sha256"),
    publication: parseBoolean("--publication", values.get("--publication")),
    signed: parseBoolean("--signed", values.get("--signed")),
    ...(expectedMacTeamId ? { expectedMacTeamId } : {}),
    ...(expectedWindowsPublisher ? { expectedWindowsPublisher } : {}),
    ...(expectedWindowsSubjectDn ? { expectedWindowsSubjectDn } : {}),
  };
}

const result = await writeReleaseArtifactProvenance(parseArgs(process.argv.slice(2)));
console.log(`Wrote ${result.path}`);
