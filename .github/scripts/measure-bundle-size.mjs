import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";

// Read-only inventory: count regular-file bytes, never follow symlinks or
// double-count an ASAR's contents in the installed application total.
function inventory(root) {
  const files = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile())
        files.push({ path: relative(root, path).replaceAll("\\", "/"), bytes: stat.size });
    }
  }
  visit(root);
  return files;
}

function group(files, key) {
  const totals = new Map();
  for (const file of files) {
    const name = key(file.path);
    totals.set(name, (totals.get(name) ?? 0) + file.bytes);
  }
  return [...totals]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

function summarize(files) {
  return {
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    fileCount: files.length,
    extensions: group(files, (path) => extname(path) || "[no extension]"),
    directories: group(files, (path) => path.split("/").slice(0, 3).join("/")),
    largestFiles: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 40),
  };
}

function readAsar(path) {
  const fd = openSync(path, "r");
  try {
    const prefix = Buffer.alloc(16);
    if (readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length)
      throw new Error(`Truncated ASAR: ${path}`);
    const length = prefix.readUInt32LE(12);
    if (length < 2 || length > 128 * 1024 * 1024) throw new Error(`Invalid ASAR header: ${path}`);
    const header = Buffer.alloc(length);
    if (readSync(fd, header, 0, length, 16) !== length)
      throw new Error(`Truncated ASAR header: ${path}`);
    const files = [];
    function visit(entries, parent = "") {
      for (const [name, entry] of Object.entries(entries)) {
        const child = parent ? `${parent}/${name}` : name;
        if (entry.files) visit(entry.files, child);
        else if (!entry.link)
          files.push({
            path: child,
            bytes: entry.size,
            unpacked: entry.unpacked === true,
            sha256: entry.integrity?.hash ?? null,
          });
      }
    }
    visit(JSON.parse(header.toString("utf8")).files);
    return {
      ...summarize(files),
      packages: group(
        files.filter((file) => file.path.startsWith("node_modules/")),
        (file) =>
          file
            .split("/")
            .slice(1, file.split("/")[1].startsWith("@") ? 3 : 2)
            .join("/"),
      ),
      files,
    };
  } finally {
    closeSync(fd);
  }
}

const [sourceArgument, outputArgument, platform] = process.argv.slice(2);
if (!sourceArgument || !outputArgument || !["mac", "linux", "win"].includes(platform)) {
  throw new Error("Usage: node measure-bundle-size.mjs SOURCE OUTPUT_DIRECTORY mac|linux|win");
}
const source = resolve(sourceArgument);
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const stages = readdirSync(tmpdir())
  .filter((name) => name.startsWith(`synara-desktop-${platform}-stage-`))
  .map((name) => join(tmpdir(), name))
  .filter((path) => existsSync(join(path, "app", "dist")))
  .sort((a, b) => lstatSync(b).mtimeMs - lstatSync(a).mtimeMs);
if (!stages[0])
  throw new Error("No retained desktop build stage found; build with --keep-stage first.");
const stage = join(stages[0], "app");
const dist = join(stage, "dist");
const packagedDirectories = readdirSync(dist).filter(
  (name) =>
    lstatSync(join(dist, name)).isDirectory() &&
    (name.startsWith("mac") || name.endsWith("-unpacked")),
);
if (packagedDirectories.length !== 1)
  throw new Error(
    `Expected one native packaged application, got ${packagedDirectories.join(", ")}`,
  );
const packagedRoot = join(dist, packagedDirectories[0]);
const packagedFiles = inventory(packagedRoot);
const asarFiles = packagedFiles.filter((file) => basename(file.path) === "app.asar");
if (asarFiles.length !== 1) throw new Error("Expected one app.asar in the packaged application.");
const asar = readAsar(join(packagedRoot, asarFiles[0].path));
const artifacts = readdirSync(dist)
  .filter((name) => /\.(dmg|zip|AppImage|exe)$/.test(name))
  .map((name) => ({
    name,
    bytes: lstatSync(join(dist, name)).size,
    sha256: createHash("sha256")
      .update(readFileSync(join(dist, name)))
      .digest("hex"),
  }));
if (artifacts.length === 0) throw new Error("No installer/update archives found.");
const report = {
  schemaVersion: 1,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
  }).trim(),
  lockfileSha256: createHash("sha256")
    .update(readFileSync(join(source, "bun.lock")))
    .digest("hex"),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
  signed: false,
  method:
    "Unsigned production packaging; installed size is regular-file byte sum without following symlinks; installer size is exact file length. ASAR inventory is reported separately, not added again.",
  artifacts,
  installed: summarize(packagedFiles),
  asar: { ...asar, archiveBytes: asarFiles[0].bytes },
  web: summarize(inventory(join(source, "apps/server/dist/client"))),
  desktopResources: summarize(inventory(join(stage, "apps/desktop/prod-resources"))),
};
writeFileSync(join(output, "bundle-size.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(output, "installed-files.json"), `${JSON.stringify(packagedFiles, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      ...report,
      asar: { ...report.asar, files: undefined, packages: report.asar.packages.slice(0, 30) },
    },
    null,
    2,
  ),
);
console.log(`Bundle size report: ${join(output, "bundle-size.json")}`);
