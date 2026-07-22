// FILE: mac-dmg-finalize.ts
// Purpose: Notarizes, staples, and validates the final signed macOS disk image.
// Layer: Release/build helper
// Exports: signed DMG finalization plus pure command construction for tests.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface MacDmgNotaryCredentials {
  readonly appleApiKey: string | undefined;
  readonly appleApiKeyId: string | undefined;
  readonly appleApiIssuer: string | undefined;
}

export interface MacDmgCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface FinalizeSignedMacDmgOptions extends MacDmgNotaryCredentials {
  readonly stageDistDir: string;
  readonly verbose?: boolean;
}

export interface FinalizedSignedMacDmg {
  readonly dmgPath: string;
  readonly dmgFileName: string;
}

const COMMAND_OUTPUT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function requireCredential(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Signed macOS DMG finalization requires ${name}.`);
  }
  return normalized;
}

export function resolveSingleMacDmgFileName(entries: ReadonlyArray<string>): string {
  const diskImages = entries.filter((entry) => entry.endsWith(".dmg"));
  if (diskImages.length !== 1 || !diskImages[0]) {
    throw new Error(`Expected one macOS DMG artifact, found ${diskImages.length}.`);
  }
  return diskImages[0];
}

export function buildMacDmgFinalizationCommands(
  dmgPath: string,
  credentials: MacDmgNotaryCredentials,
): ReadonlyArray<MacDmgCommand> {
  const appleApiKey = requireCredential(credentials.appleApiKey, "APPLE_API_KEY");
  const appleApiKeyId = requireCredential(credentials.appleApiKeyId, "APPLE_API_KEY_ID");
  const appleApiIssuer = requireCredential(credentials.appleApiIssuer, "APPLE_API_ISSUER");

  return [
    {
      command: "codesign",
      args: ["--verify", "--strict", "--verbose=4", dmgPath],
    },
    {
      command: "xcrun",
      args: [
        "notarytool",
        "submit",
        dmgPath,
        "--key",
        appleApiKey,
        "--key-id",
        appleApiKeyId,
        "--issuer",
        appleApiIssuer,
        "--wait",
      ],
    },
    {
      command: "xcrun",
      args: ["stapler", "staple", dmgPath],
    },
    {
      command: "codesign",
      args: ["--verify", "--strict", "--verbose=4", dmgPath],
    },
    {
      command: "spctl",
      args: [
        "--assess",
        "--type",
        "open",
        "--context",
        "context:primary-signature",
        "--verbose=4",
        dmgPath,
      ],
    },
    {
      command: "xcrun",
      args: ["stapler", "validate", dmgPath],
    },
  ];
}

function runCommand(command: MacDmgCommand, verbose: boolean): void {
  const result = spawnSync(command.command, [...command.args], {
    encoding: "utf8",
    maxBuffer: COMMAND_OUTPUT_MAX_BUFFER_BYTES,
  });
  if (verbose && result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (verbose && result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `${command.command} failed with exit code ${result.status ?? "unknown"}${detail ? `: ${detail}` : ""}`,
    );
  }
}

export function finalizeSignedMacDmg(options: FinalizeSignedMacDmgOptions): FinalizedSignedMacDmg {
  if (process.platform !== "darwin") {
    throw new Error("Signed macOS DMG finalization must run on macOS.");
  }

  const dmgFileName = resolveSingleMacDmgFileName(readdirSync(options.stageDistDir));
  const dmgPath = join(options.stageDistDir, dmgFileName);
  if (!existsSync(dmgPath)) {
    throw new Error(`macOS DMG artifact was not found at ${dmgPath}.`);
  }

  for (const command of buildMacDmgFinalizationCommands(dmgPath, options)) {
    runCommand(command, options.verbose === true);
  }

  return { dmgPath, dmgFileName };
}
