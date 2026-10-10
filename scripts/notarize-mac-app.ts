import {
  existsSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { hashFile } from "./lib/file-digest.ts";
import { join } from "node:path";
import {
  appNotaryStateDirectory,
  notarizeMacPayload,
  runMacCommand,
} from "./lib/mac-notarization.ts";

const app = process.argv[2];
if (process.platform !== "darwin" || !app?.endsWith(".app"))
  throw new Error("Expected a signed macOS app bundle.");
const root = appNotaryStateDirectory(app);
mkdirSync(root, { recursive: true });
const inputPath = join(root, "app-input.json");
async function appDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(relative: string): Promise<void> {
    const entry = join(path, relative);
    const stat = lstatSync(entry);
    hash.update(JSON.stringify([relative, stat.mode]));
    if (stat.isSymbolicLink()) hash.update(readlinkSync(entry));
    else if (stat.isDirectory())
      for (const child of readdirSync(entry).toSorted()) await visit(join(relative, child));
    else if (stat.isFile()) hash.update(await hashFile(entry));
    else throw new Error(`Unexpected app bundle entry: ${entry}`);
  }
  await visit("");
  return hash.digest("hex");
}
const archive = join(root, "app.zip");
runMacCommand(
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=4", app],
  "app-signature-validation",
);
const digest = await appDigest(app);
if (existsSync(inputPath)) {
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  if (input.original !== digest && input.stapled !== digest)
    throw new Error(
      "Signed app changed; remove its stale .app-notary directory before submitting again.",
    );
} else {
  runMacCommand(
    "ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive],
    "app-notary-archive",
  );
  writeFileSync(inputPath, JSON.stringify({ original: digest }) + "\n");
}
await notarizeMacPayload(
  archive,
  {
    appleApiKey: process.env.APPLE_API_KEY,
    appleApiKeyId: process.env.APPLE_API_KEY_ID,
    appleApiIssuer: process.env.APPLE_API_ISSUER,
  },
  root,
  "app",
);
runMacCommand("xcrun", ["stapler", "staple", app], "app-staple");
writeFileSync(
  inputPath,
  JSON.stringify({
    ...JSON.parse(readFileSync(inputPath, "utf8")),
    stapled: await appDigest(app),
  }) + "\n",
);
runMacCommand("xcrun", ["stapler", "validate", app], "app-staple-validation");
runMacCommand(
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=4", app],
  "app-final-signature-validation",
);
// Retain the archive, digests and submission ID with this exact packaging stage.
