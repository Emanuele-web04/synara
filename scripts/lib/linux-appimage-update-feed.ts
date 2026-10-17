// Finalize the Linux updater feed after electron-builder emits all package formats.
// Debian and RPM are distribution downloads, never self-update payloads.
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

const requireScripts = createRequire(new URL("../package.json", import.meta.url));
const requireBuilder = createRequire(requireScripts.resolve("electron-builder"));
const requireAppBuilder = createRequire(requireBuilder.resolve("app-builder-lib"));
const yaml = requireAppBuilder("js-yaml") as {
  load: (content: string) => unknown;
  dump: (content: unknown, options?: Record<string, unknown>) => string;
};

interface FinalizeLinuxAppImageUpdateFeedInput {
  readonly stageDistDir: string;
  readonly arch: "x64" | "arm64";
  readonly version: string;
}

interface UpdateFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
  readonly [key: string]: unknown;
}

function isUpdateFile(value: unknown): value is UpdateFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.url === "string" &&
    typeof file.sha512 === "string" &&
    typeof file.size === "number" &&
    Number.isSafeInteger(file.size) &&
    file.size > 0
  );
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("base64");
}

/**
 * electron-builder can merge the AppImage, Deb and RPM events into one latest-linux
 * feed even when per-target publish is null. Keep the updater authoritative to the
 * real AppImage binary and fail closed on inconsistent generated metadata.
 */
export async function finalizeLinuxAppImageUpdateFeed(
  input: FinalizeLinuxAppImageUpdateFeedInput,
): Promise<string> {
  const entries = readdirSync(input.stageDistDir);
  const appImages = entries.filter((entry) => entry.endsWith(".AppImage"));
  if (appImages.length !== 1) {
    throw new Error(`Expected one Linux AppImage, found ${appImages.length}.`);
  }
  const appImageName = appImages[0]!;
  const manifestName = input.arch === "x64" ? "latest-linux.yml" : `latest-linux-${input.arch}.yml`;
  const manifestPath = join(input.stageDistDir, manifestName);
  const decoded = yaml.load(readFileSync(manifestPath, "utf8"));
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Invalid Linux updater manifest.");
  }
  const manifest = decoded as Record<string, unknown>;
  if (manifest.version !== input.version) {
    throw new Error("Linux updater manifest version differs from the packaged application.");
  }
  if (!Array.isArray(manifest.files) || !manifest.files.every(isUpdateFile)) {
    throw new Error("Linux updater manifest has malformed payload entries.");
  }
  const files = manifest.files as UpdateFile[];
  const imageFiles = files.filter((file) => file.url === appImageName);
  if (imageFiles.length !== 1) {
    throw new Error("Linux updater manifest must contain exactly one packaged AppImage.");
  }

  for (const file of files) {
    if (
      basename(file.url) !== file.url ||
      (file.url !== appImageName && (!entries.includes(file.url) || !/\.(deb|rpm)$/.test(file.url)))
    ) {
      throw new Error(`Unexpected Linux updater payload: ${file.url}`);
    }
  }

  const image = imageFiles[0]!;
  const imagePath = join(input.stageDistDir, appImageName);
  const size = statSync(imagePath).size;
  const sha512 = await hashFile(imagePath);
  if (image.size !== size || image.sha512 !== sha512) {
    throw new Error("Linux AppImage updater metadata does not match the built artifact.");
  }

  // Preserve builder-generated release metadata and the verified AppImage entry.
  // Only the package-manager entries and their obsolete top-level pointer change.
  const normalized = {
    ...manifest,
    files: [image],
    path: appImageName,
    sha512,
  };
  writeFileSync(manifestPath, yaml.dump(normalized, { lineWidth: -1, noRefs: true }));
  return manifestPath;
}
