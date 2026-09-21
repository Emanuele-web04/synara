import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const destination = "/private/tmp/synara-cua-implementation/Synara Cua Canary.app";
const resources = join(destination, "Contents/Resources");
const plist = join(destination, "Contents/Info.plist");

function run(command, args) {
  try {
    execFileSync(command, args, {
      cwd: root,
      stdio: ["ignore", "inherit", "pipe"],
    });
  } catch (error) {
    if (error.stderr) process.stderr.write(error.stderr);
    else process.stderr.write(`${error}\n`);
    process.exit(1);
  }
}

await rm(destination, { recursive: true, force: true });
await cp(join(root, "apps/desktop/node_modules/electron/dist/Electron.app"), destination, {
  recursive: true,
  verbatimSymlinks: true,
});

run("/usr/bin/clang", [
  "-fobjc-arc",
  "-O2",
  "-o",
  join(resources, "belief-probe"),
  join(root, "scripts/computer-use-fixtures/belief_probe.m"),
  "-framework",
  "AppKit",
  "-framework",
  "ApplicationServices",
  "-framework",
  "CoreGraphics",
]);

for (const [key, value] of Object.entries({
  CFBundleIdentifier: "com.synara.cua-canary",
  CFBundleName: "Synara Cua Canary",
  CFBundleDisplayName: "Synara Cua Canary",
  NSAccessibilityUsageDescription:
    "Canary probe: test background input into this bundle's own windows.",
  NSScreenCaptureUsageDescription:
    "Canary probe: test background input into this bundle's own windows.",
}))
  run("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);

run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", destination]);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", destination]);

// App payload: the canary main-process entry, its app manifest, the bundled
// driver, and the native release manifest the entry reports. Every addition
// above invalidates the earlier seal, so signing runs again after them.
await mkdir(join(resources, "app"), { recursive: true });
run("bun", [
  "build",
  join(root, "scripts/computer-use-fixtures/canary-main.ts"),
  "--target=node",
  "--format=cjs",
  "--external=electron",
  `--outfile=${join(resources, "app/canary.cjs")}`,
]);
await writeFile(
  join(resources, "app/package.json"),
  JSON.stringify({ name: "synara-cua-canary", main: "canary.cjs" }),
);
await cp(join(root, "apps/desktop/resources/cua-driver"), join(resources, "cua-driver"), {
  recursive: true,
});
await writeFile(
  join(resources, "fixture-native.json"),
  JSON.stringify(
    {
      source: JSON.parse(
        await readFile(join(root, "packages/shared/src/cuaDriverRelease.json"), "utf8"),
      ),
    },
    null,
    2,
  ),
);
run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", destination]);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", destination]);
console.log("canary build ok");
