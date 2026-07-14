// FILE: release-artifact-provenance.ts
// Purpose: Hashes collected release assets and proves platform signing before upload.
// Layer: Release/build helper

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type ReleaseArtifactPlatform = "linux" | "mac" | "win";

export interface ReleaseArtifactProvenanceInput {
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
  readonly artifactFileNames?: ReadonlyArray<string>;
}

export interface ReleaseArtifactDigest {
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface WindowsSignatureEvidence {
  readonly fileName: string;
  readonly subject: string;
  readonly publisher: string;
  readonly thumbprint: string;
  readonly timestampSubject: string;
  readonly timestampThumbprint: string;
}

interface MacSignatureEvidence {
  readonly teamId: string;
  readonly authorities: ReadonlyArray<string>;
  readonly appBundle: string;
  readonly diskImage: string;
}

type SigningEvidence =
  | {
      readonly status: "verified";
      readonly scheme: "apple-developer-id";
      readonly identity: MacSignatureEvidence;
      readonly checks: ReadonlyArray<string>;
    }
  | {
      readonly status: "verified";
      readonly scheme: "windows-authenticode";
      readonly identity: ReadonlyArray<WindowsSignatureEvidence>;
      readonly checks: ReadonlyArray<string>;
    }
  | {
      readonly status: "not-applicable";
      readonly scheme: "none";
      readonly identity: null;
      readonly checks: ReadonlyArray<string>;
    }
  | {
      readonly status: "unsigned-build-only";
      readonly scheme: "none";
      readonly identity: null;
      readonly checks: ReadonlyArray<string>;
    };

export interface ReleaseArtifactProvenanceManifest {
  readonly schemaVersion: 1;
  readonly publication: boolean;
  readonly platform: ReleaseArtifactPlatform;
  readonly arch: string;
  readonly target: string;
  readonly version: string;
  readonly source: {
    readonly commit: string;
    readonly tag: string | null;
    readonly lockfileSha256: string;
  };
  readonly signing: SigningEvidence;
  readonly artifacts: ReadonlyArray<ReleaseArtifactDigest>;
}

const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;

function runCommand(command: string, args: ReadonlyArray<string>): CommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function requireSingleArtifact(
  artifacts: ReadonlyArray<ReleaseArtifactDigest>,
  suffix: string,
): ReleaseArtifactDigest {
  const matches = artifacts.filter((artifact) => artifact.fileName.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${suffix} artifact, found ${matches.length}.`);
  }
  return matches[0]!;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export async function collectReleaseArtifactDigests(
  assetsDirectory: string,
  artifactFileNames?: ReadonlyArray<string>,
): Promise<ReadonlyArray<ReleaseArtifactDigest>> {
  const fileNames = (artifactFileNames ?? readdirSync(assetsDirectory))
    .filter((fileName) => !fileName.endsWith(".provenance.json"))
    .sort((left, right) => left.localeCompare(right));
  if (new Set(fileNames).size !== fileNames.length) {
    throw new Error("Release artifact file names must be unique.");
  }
  if (fileNames.length === 0) {
    throw new Error(`No release assets found in ${assetsDirectory}.`);
  }

  const artifacts: ReleaseArtifactDigest[] = [];
  for (const fileName of fileNames) {
    const filePath = join(assetsDirectory, fileName);
    const entry = lstatSync(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Release asset must be a regular file: ${fileName}`);
    }
    artifacts.push({
      fileName,
      size: entry.size,
      sha256: await hashFile(filePath),
    });
  }
  return artifacts;
}

function parseMacIdentity(output: string): {
  readonly teamId: string;
  readonly authorities: ReadonlyArray<string>;
} {
  const teamId = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim();
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (!teamId || authorities.length === 0) {
    throw new Error("codesign returned incomplete signing identity output.");
  }
  return { teamId, authorities };
}

function verifyMacSignatures(
  input: ReleaseArtifactProvenanceInput,
  artifacts: ReadonlyArray<ReleaseArtifactDigest>,
): SigningEvidence {
  if (process.platform !== "darwin") {
    throw new Error("macOS artifact verification must run on macOS.");
  }
  const expectedTeamId = input.expectedMacTeamId?.trim();
  if (!expectedTeamId) {
    throw new Error("Signed macOS provenance requires an expected Apple team ID.");
  }

  const zip = requireSingleArtifact(artifacts, ".zip");
  const diskImage = requireSingleArtifact(artifacts, ".dmg");
  const extractionRoot = mkdtempSync(join(tmpdir(), "synara-release-provenance-"));
  try {
    runCommand("ditto", ["-x", "-k", join(input.assetsDirectory, zip.fileName), extractionRoot]);
    const appBundles = readdirSync(extractionRoot).filter((entry) => {
      const candidate = join(extractionRoot, entry);
      return entry.endsWith(".app") && statSync(candidate).isDirectory();
    });
    if (appBundles.length !== 1) {
      throw new Error(`Expected one top-level app bundle in ${zip.fileName}.`);
    }

    const appBundleName = appBundles[0]!;
    const appBundlePath = join(extractionRoot, appBundleName);
    runCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appBundlePath]);
    const appIdentityOutput = runCommand("codesign", ["-d", "--verbose=4", appBundlePath]);
    const appIdentity = parseMacIdentity(
      `${appIdentityOutput.stdout}\n${appIdentityOutput.stderr}`,
    );
    if (appIdentity.teamId !== expectedTeamId) {
      throw new Error(
        `macOS app team ID ${appIdentity.teamId} does not match expected ${expectedTeamId}.`,
      );
    }
    runCommand("spctl", ["--assess", "--type", "execute", "--verbose=4", appBundlePath]);
    runCommand("xcrun", ["stapler", "validate", appBundlePath]);

    const diskImagePath = join(input.assetsDirectory, diskImage.fileName);
    runCommand("codesign", ["--verify", "--strict", "--verbose=4", diskImagePath]);
    const diskImageIdentityOutput = runCommand("codesign", [
      "-d",
      "--verbose=4",
      diskImagePath,
    ]);
    const diskImageIdentity = parseMacIdentity(
      `${diskImageIdentityOutput.stdout}\n${diskImageIdentityOutput.stderr}`,
    );
    if (diskImageIdentity.teamId !== expectedTeamId) {
      throw new Error(
        `macOS disk image team ID ${diskImageIdentity.teamId} does not match expected ${expectedTeamId}.`,
      );
    }
    runCommand("spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      diskImagePath,
    ]);

    return {
      status: "verified",
      scheme: "apple-developer-id",
      identity: {
        teamId: appIdentity.teamId,
        authorities: appIdentity.authorities,
        appBundle: appBundleName,
        diskImage: diskImage.fileName,
      },
      checks: [
        "codesign --verify app",
        "spctl --assess app",
        "stapler validate app",
        "codesign --verify dmg",
        "spctl --assess dmg",
      ],
    };
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function escapePowerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function verifyWindowsSignatures(
  input: ReleaseArtifactProvenanceInput,
  artifacts: ReadonlyArray<ReleaseArtifactDigest>,
): SigningEvidence {
  if (process.platform !== "win32") {
    throw new Error("Windows artifact verification must run on Windows.");
  }
  const expectedPublisher = input.expectedWindowsPublisher?.trim();
  if (!expectedPublisher) {
    throw new Error("Signed Windows provenance requires an expected publisher.");
  }
  const expectedSubjectDn = input.expectedWindowsSubjectDn?.trim();
  if (!expectedSubjectDn) {
    throw new Error("Signed Windows provenance requires an expected subject DN.");
  }
  const executables = artifacts.filter((artifact) => artifact.fileName.endsWith(".exe"));
  if (executables.length === 0) {
    throw new Error("Expected at least one Windows executable artifact.");
  }

  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot) {
    throw new Error("SystemRoot is required for Windows signature verification.");
  }
  const powershell = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const identity: WindowsSignatureEvidence[] = [];
  for (const executable of executables) {
    const executablePath = resolve(input.assetsDirectory, executable.fileName);
    const literalPath = escapePowerShellLiteral(executablePath);
    const command = [
      `$signature = Get-AuthenticodeSignature -LiteralPath '${literalPath}'`,
      "$certificate = $signature.SignerCertificate",
      "$timestamp = $signature.TimeStamperCertificate",
      "[PSCustomObject]@{ Status = [string]$signature.Status; Path = $signature.Path; Subject = $certificate.Subject; Publisher = $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false); Thumbprint = $certificate.Thumbprint; TimestampSubject = $timestamp.Subject; TimestampThumbprint = $timestamp.Thumbprint } | ConvertTo-Json -Compress",
    ].join("; ");
    const result = runCommand(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat",
      "None",
      "-Command",
      command,
    ]);
    if (result.stderr.trim().length > 0) {
      throw new Error(`PowerShell signature verification wrote stderr: ${result.stderr.trim()}`);
    }
    const signature = JSON.parse(result.stdout) as Record<string, unknown>;
    if (signature.Status !== "Valid") {
      throw new Error(`${executable.fileName} Authenticode status is ${String(signature.Status)}.`);
    }
    if (
      typeof signature.Path !== "string" ||
      resolve(signature.Path).toLowerCase() !== executablePath.toLowerCase()
    ) {
      throw new Error(`${executable.fileName} signature path does not match the collected asset.`);
    }
    if (signature.Publisher !== expectedPublisher) {
      throw new Error(
        `${executable.fileName} publisher ${String(signature.Publisher)} does not match expected ${expectedPublisher}.`,
      );
    }
    if (signature.Subject !== expectedSubjectDn) {
      throw new Error(
        `${executable.fileName} subject ${String(signature.Subject)} does not match expected ${expectedSubjectDn}.`,
      );
    }
    if (
      typeof signature.Subject !== "string" ||
      typeof signature.Thumbprint !== "string" ||
      !/^[0-9a-f]{40,64}$/i.test(signature.Thumbprint) ||
      typeof signature.TimestampSubject !== "string" ||
      typeof signature.TimestampThumbprint !== "string" ||
      !/^[0-9a-f]{40,64}$/i.test(signature.TimestampThumbprint)
    ) {
      throw new Error(`${executable.fileName} returned incomplete certificate identity.`);
    }
    identity.push({
      fileName: executable.fileName,
      subject: signature.Subject,
      publisher: expectedPublisher,
      thumbprint: signature.Thumbprint.toUpperCase(),
      timestampSubject: signature.TimestampSubject,
      timestampThumbprint: signature.TimestampThumbprint.toUpperCase(),
    });
  }

  return {
    status: "verified",
    scheme: "windows-authenticode",
    identity,
    checks: [
      "Get-AuthenticodeSignature Status=Valid",
      "publisher exact match",
      "subject DN exact match",
    ],
  };
}

function resolveSigningEvidence(
  input: ReleaseArtifactProvenanceInput,
  artifacts: ReadonlyArray<ReleaseArtifactDigest>,
): SigningEvidence {
  if (input.platform === "linux") {
    if (input.signed) {
      throw new Error("Linux release provenance cannot claim an unsupported signing scheme.");
    }
    requireSingleArtifact(artifacts, ".AppImage");
    return {
      status: "not-applicable",
      scheme: "none",
      identity: null,
      checks: ["AppImage payload present"],
    };
  }

  if (!input.signed) {
    if (input.publication) {
      throw new Error(`Publishing ${input.platform} artifacts requires verified signing.`);
    }
    requireSingleArtifact(artifacts, input.platform === "mac" ? ".dmg" : ".exe");
    return {
      status: "unsigned-build-only",
      scheme: "none",
      identity: null,
      checks: ["publication disabled"],
    };
  }

  return input.platform === "mac"
    ? verifyMacSignatures(input, artifacts)
    : verifyWindowsSignatures(input, artifacts);
}

function validateInput(input: ReleaseArtifactProvenanceInput): void {
  if (!/^[0-9a-f]{40}$/i.test(input.sourceCommit)) {
    throw new Error("Artifact provenance requires a full source commit.");
  }
  if (!/^[0-9a-f]{64}$/i.test(input.lockfileSha256)) {
    throw new Error("Artifact provenance requires a bun.lock SHA-256.");
  }
  if (input.sourceTag !== null && input.sourceTag !== `v${input.version}`) {
    throw new Error(`Source tag ${input.sourceTag} does not match version ${input.version}.`);
  }
  if (input.publication && input.sourceTag === null) {
    throw new Error("Published artifact provenance requires an exact source tag.");
  }
}

export async function writeReleaseArtifactProvenance(
  input: ReleaseArtifactProvenanceInput,
): Promise<{ readonly manifest: ReleaseArtifactProvenanceManifest; readonly path: string }> {
  validateInput(input);
  const artifacts = await collectReleaseArtifactDigests(
    input.assetsDirectory,
    input.artifactFileNames,
  );
  const manifest: ReleaseArtifactProvenanceManifest = {
    schemaVersion: 1,
    publication: input.publication,
    platform: input.platform,
    arch: input.arch,
    target: input.target,
    version: input.version,
    source: {
      commit: input.sourceCommit.toLowerCase(),
      tag: input.sourceTag,
      lockfileSha256: input.lockfileSha256.toLowerCase(),
    },
    signing: resolveSigningEvidence(input, artifacts),
    artifacts,
  };
  const outputPath = join(
    input.assetsDirectory,
    `artifact-${input.platform}-${input.arch}.provenance.json`,
  );
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { manifest, path: outputPath };
}
