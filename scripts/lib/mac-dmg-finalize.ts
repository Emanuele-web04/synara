// FILE: mac-dmg-finalize.ts
// Purpose: Notarizes, staples, and validates the final signed macOS disk image.
// Layer: Release/build helper
// Exports: signed DMG finalization plus pure command construction for tests.

import { notarizeMacPayload, recordStapledPayload, runMacCommand } from "./mac-notarization.ts";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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

export interface RebuildUnsignedMacDmgOptions {
  readonly stageDistDir: string;
  readonly productName: string;
  readonly verbose?: boolean;
}

export function buildUnsignedMacDmgCommands(
  appBundlePath: string,
  imageRoot: string,
  dmgPath: string,
  productName: string,
): ReadonlyArray<MacDmgCommand> {
  return [
    {
      command: "ditto",
      args: [appBundlePath, join(imageRoot, `${productName}.app`)],
    },
    {
      command: "hdiutil",
      args: [
        "create",
        "-volname",
        productName,
        "-srcfolder",
        imageRoot,
        "-ov",
        "-format",
        "UDZO",
        dmgPath,
      ],
    },
  ];
}

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

function runCommand(command: MacDmgCommand, _verbose: boolean): void {
  runMacCommand(command.command, command.args, `dmg-${command.command}-${command.args[0]}`);
}

function findFirstMacAppBundle(root: string): string | null {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      const candidate = join(current, entry);
      const stat = statSync(candidate);
      if (!stat.isDirectory()) continue;
      if (entry.endsWith(".app")) return candidate;
      pending.push(candidate);
    }
  }
  return null;
}

export function rebuildUnsignedMacDmg(
  options: RebuildUnsignedMacDmgOptions,
): FinalizedSignedMacDmg {
  if (process.platform !== "darwin") {
    throw new Error("Unsigned macOS DMG rebuilding must run on macOS.");
  }
  const dmgFileName = resolveSingleMacDmgFileName(readdirSync(options.stageDistDir));
  const dmgPath = join(options.stageDistDir, dmgFileName);
  const appBundlePath = findFirstMacAppBundle(options.stageDistDir);
  if (!appBundlePath) {
    throw new Error(`Could not find packaged .app bundle inside ${options.stageDistDir}.`);
  }

  const imageRoot = mkdtempSync(join(tmpdir(), "synara-mac-dmg-"));
  try {
    const [copyAppCommand, createDmgCommand] = buildUnsignedMacDmgCommands(
      appBundlePath,
      imageRoot,
      dmgPath,
      options.productName,
    );
    if (!copyAppCommand || !createDmgCommand) {
      throw new Error("Unsigned macOS DMG commands were not constructed.");
    }
    runCommand(copyAppCommand, options.verbose === true);
    symlinkSync("/Applications", join(imageRoot, "Applications"));
    rmSync(dmgPath, { force: true });
    runCommand(createDmgCommand, options.verbose === true);
  } finally {
    rmSync(imageRoot, { force: true, recursive: true });
  }

  if (!existsSync(dmgPath)) {
    throw new Error(`Rebuilt macOS DMG artifact was not found at ${dmgPath}.`);
  }
  return { dmgPath, dmgFileName };
}

export async function finalizeSignedMacDmg(
  options: FinalizeSignedMacDmgOptions,
): Promise<FinalizedSignedMacDmg> {
  if (process.platform !== "darwin") {
    throw new Error("Signed macOS DMG finalization must run on macOS.");
  }

  const dmgFileName = resolveSingleMacDmgFileName(readdirSync(options.stageDistDir));
  const dmgPath = join(options.stageDistDir, dmgFileName);
  if (!existsSync(dmgPath)) {
    throw new Error(`macOS DMG artifact was not found at ${dmgPath}.`);
  }

  let submission;
  for (const command of buildMacDmgFinalizationCommands(dmgPath, options)) {
    if (command.command === "xcrun" && command.args[0] === "notarytool") {
      submission = await notarizeMacPayload(
        dmgPath,
        options,
        join(options.stageDistDir, ".notary-state"),
        "dmg",
      );
    } else {
      runCommand(command, options.verbose === true);
      if (command.args[0] === "stapler" && command.args[1] === "staple" && submission)
        await recordStapledPayload(dmgPath, submission);
    }
  }

  return { dmgPath, dmgFileName };
}
