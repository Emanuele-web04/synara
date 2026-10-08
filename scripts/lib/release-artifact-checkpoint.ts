// Verifies the bytes and identity of a checkpoint downloaded from this workflow run.
// The packaging job owns native signature verification; this is not cross-run authorization.
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { hashFile } from "./file-digest.ts";
import type {
  ReleaseArtifactProvenanceInput,
  ReleaseArtifactProvenanceManifest,
} from "./release-artifact-provenance.ts";

// Qualification has no dependency install. Resolve this owned, dependency-free shared
// module from the checkout, while keeping its types behind the shared subpath export.
const { matchesDistinguishedName }: typeof import("@synara/shared/windowsCertificate") =
  await import(new URL("../../packages/shared/src/windowsCertificate.ts", import.meta.url).href);

export interface ReleaseArtifactCheckpointInput extends Pick<
  ReleaseArtifactProvenanceInput,
  | "assetsDirectory"
  | "platform"
  | "arch"
  | "target"
  | "version"
  | "sourceCommit"
  | "sourceTag"
  | "lockfileSha256"
  | "publication"
  | "allowUnsignedWindowsPublication"
  | "expectedMacTeamId"
  | "expectedWindowsPublisher"
  | "expectedWindowsSubjectDn"
> {
  readonly flavor: "production" | "beta";
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid checkpoint ${name}.`);
  }
  return value as Record<string, unknown>;
}

function regularFile(path: string): number {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Checkpoint entry must be a regular file: ${path}`);
  }
  return entry.size;
}

function equal(name: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Checkpoint ${name} does not match this release.`);
}

function verifySigning(
  value: unknown,
  input: ReleaseArtifactCheckpointInput,
  payloads: ReadonlyArray<string>,
): void {
  const signing = record(value, "signing evidence");
  if (
    !Array.isArray(signing.checks) ||
    signing.checks.length === 0 ||
    signing.checks.some((check) => typeof check !== "string" || !check)
  ) {
    throw new Error("Checkpoint signing checks are missing.");
  }
  if (input.platform === "linux") {
    equal("Linux signing status", signing.status, "not-applicable");
    equal("Linux signing scheme", signing.scheme, "none");
    equal("Linux signing identity", signing.identity, null);
    return;
  }
  if (signing.status === "verified") {
    if (input.platform === "mac") {
      equal("macOS signing scheme", signing.scheme, "apple-developer-id");
      const identity = record(signing.identity, "macOS signing identity");
      if (typeof identity.teamId !== "string" || !identity.teamId) {
        throw new Error("Checkpoint macOS signing team is missing.");
      }
      const expectedTeamId = input.expectedMacTeamId?.trim();
      if (!expectedTeamId) throw new Error("Signed macOS checkpoint requires an expected team ID.");
      equal("macOS team", identity.teamId, expectedTeamId);
    } else {
      equal("Windows signing scheme", signing.scheme, "windows-authenticode");
      if (!Array.isArray(signing.identity) || signing.identity.length !== 1) {
        throw new Error("Checkpoint Windows signing identity is missing.");
      }
      const identity = record(signing.identity[0], "Windows signing identity");
      equal("Windows signed executable", identity.fileName, payloads[0]);
      if (typeof identity.publisher !== "string" || !identity.publisher) {
        throw new Error("Checkpoint Windows signing publisher is missing.");
      }
      const expectedPublisher = input.expectedWindowsPublisher?.trim();
      const expectedSubjectDn = input.expectedWindowsSubjectDn?.trim();
      if (!expectedPublisher) {
        throw new Error("Signed Windows checkpoint requires an expected publisher.");
      }
      if (!expectedSubjectDn) {
        throw new Error("Signed Windows checkpoint requires an expected subject DN.");
      }
      equal("Windows publisher", identity.publisher, expectedPublisher);
      if (
        typeof identity.subject !== "string" ||
        !matchesDistinguishedName(expectedSubjectDn, identity.subject)
      ) {
        throw new Error("Checkpoint Windows subject DN does not match this release.");
      }
    }
    return;
  }
  const expectedStatus = input.publication ? "unsigned-explicit-release" : "unsigned-build-only";
  if (
    input.publication &&
    !(input.platform === "win" && input.allowUnsignedWindowsPublication === true)
  ) {
    throw new Error("Checkpoint publication requires verified signing.");
  }
  equal("unsigned signing status", signing.status, expectedStatus);
  equal("unsigned signing scheme", signing.scheme, "none");
  equal("unsigned signing identity", signing.identity, null);
}

export async function verifyReleaseArtifactCheckpoint(
  input: ReleaseArtifactCheckpointInput,
): Promise<ReleaseArtifactProvenanceManifest> {
  const validTarget = { mac: "dmg", win: "nsis", linux: "AppImage" }[input.platform];
  if (
    input.target !== validTarget ||
    !["arm64", "x64"].includes(input.arch) ||
    (input.platform !== "mac" && input.arch !== "x64") ||
    !["production", "beta"].includes(input.flavor) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version) ||
    !/^[0-9a-f]{40}$/i.test(input.sourceCommit) ||
    !/^[0-9a-f]{64}$/i.test(input.lockfileSha256) ||
    (input.sourceTag !== null && input.sourceTag !== `v${input.version}`) ||
    (input.publication && input.sourceTag === null)
  ) {
    throw new Error("Invalid expected release checkpoint identity.");
  }
  const root = lstatSync(input.assetsDirectory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("Checkpoint assets directory must be a real directory.");
  }
  const manifestName = `artifact-${input.platform}-${input.arch}.provenance.json`;
  const manifestPath = join(input.assetsDirectory, manifestName);
  regularFile(manifestPath);
  const manifest = record(JSON.parse(readFileSync(manifestPath, "utf8")), "manifest");
  equal("schema", manifest.schemaVersion, 1);
  for (const key of ["platform", "arch", "target", "version", "publication"] as const) {
    equal(key, manifest[key], input[key]);
  }
  const source = record(manifest.source, "source");
  equal("source commit", source.commit, input.sourceCommit.toLowerCase());
  equal("source tag", source.tag, input.sourceTag);
  equal("lockfile", source.lockfileSha256, input.lockfileSha256.toLowerCase());

  const stem = `${input.flavor === "beta" ? "Synara-Beta" : "Synara"}-${input.version}-${input.arch}`;
  const payloads =
    input.platform === "mac"
      ? [`${stem}.dmg`, `${stem}.zip`]
      : [`${stem}.${input.platform === "win" ? "exe" : "AppImage"}`];
  const updaterName =
    input.platform === "mac"
      ? `latest-mac${input.arch === "x64" ? "-x64" : ""}.yml`
      : `latest${input.platform === "linux" ? "-linux" : ""}.yml`;
  const allowedNames = new Set([
    ...payloads,
    ...payloads.map((name) => `${name}.blockmap`),
    updaterName,
  ]);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("Checkpoint artifact inventory is missing.");
  }
  const expectedFiles = new Set([manifestName]);
  for (const value of manifest.artifacts) {
    const artifact = record(value, "artifact");
    const fileName = artifact.fileName;
    if (
      typeof fileName !== "string" ||
      !allowedNames.has(fileName) ||
      expectedFiles.has(fileName)
    ) {
      throw new Error("Checkpoint contains an unexpected or duplicate artifact name.");
    }
    if (
      !Number.isSafeInteger(artifact.size) ||
      (artifact.size as number) < 0 ||
      typeof artifact.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256)
    ) {
      throw new Error(`Invalid checkpoint digest for ${fileName}.`);
    }
    expectedFiles.add(fileName);
    const path = join(input.assetsDirectory, fileName);
    equal(`${fileName} size`, regularFile(path), artifact.size);
    equal(`${fileName} checksum`, await hashFile(path), artifact.sha256);
  }
  for (const required of [...payloads, updaterName]) {
    if (!expectedFiles.has(required))
      throw new Error(`Checkpoint is missing required asset ${required}.`);
  }
  const actualFiles = readdirSync(input.assetsDirectory);
  if (
    actualFiles.length !== expectedFiles.size ||
    actualFiles.some((name) => !expectedFiles.has(name))
  ) {
    throw new Error("Checkpoint file inventory does not match its provenance.");
  }
  verifySigning(manifest.signing, input, payloads);
  return manifest as unknown as ReleaseArtifactProvenanceManifest;
}
