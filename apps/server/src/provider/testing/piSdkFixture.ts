// FILE: piSdkFixture.ts
// Purpose: Creates local Pi install layouts without accounts, networking, or inference.
// Layer: Provider test support

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { makePiPackageImporter } from "../piSdkImports.ts";

export const importTestPiPackage = makePiPackageImporter(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);

export function writePiInstallFixture(
  root: string,
  version: string,
  layout: "npm" | "bun" | "npm-cmd" | "bun-exe" = process.platform === "win32" ? "npm-cmd" : "npm",
) {
  const binaryDir = layout === "npm-cmd" ? root : join(root, "bin");
  const modules = join(
    root,
    ...(layout === "bun" || layout === "bun-exe"
      ? ["install", "global"]
      : layout === "npm"
        ? ["lib"]
        : []),
    "node_modules",
  );
  const agent = join(modules, "@earendil-works", "pi-coding-agent");
  const ai = join(agent, "node_modules", "@earendil-works", "pi-ai");
  for (const [directory, label] of [
    [ai, version],
    [join(modules, "@earendil-works", "pi-ai"), "hoisted-decoy"],
  ] as const) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-ai",
        type: "module",
        exports: {
          ".": { import: "./index.js" },
          "./compat": { import: "./index.js" },
          "./providers/*": { import: "./index.js" },
          "./utils/*": { import: "./index.js" },
        },
      }),
    );
    writeFileSync(
      join(directory, "index.js"),
      `export const version = ${JSON.stringify(label)};\n`,
    );
  }
  writeFileSync(
    join(agent, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      type: "module",
      exports: { ".": { import: "./index.js" } },
      bin: { pi: "./cli.js" },
    }),
  );
  writeFileSync(join(agent, "index.js"), 'export { version } from "@earendil-works/pi-ai";\n');
  const cli = join(agent, "cli.js");
  writeFileSync(cli, "#!/usr/bin/env node\n", { mode: 0o755 });
  const binary = join(
    binaryDir,
    layout === "npm-cmd" ? "pi.cmd" : layout === "bun-exe" ? "pi.exe" : "pi",
  );
  mkdirSync(dirname(binary), { recursive: true });
  if (layout === "npm-cmd") {
    writeFileSync(
      binary,
      `@ECHO OFF\r\n"node" "%dp0%\\${relative(binaryDir, cli).replaceAll("/", "\\")}" %*\r\n`,
      {
        mode: 0o755,
      },
    );
  } else if (layout === "bun-exe") {
    const target = relative(root, cli).replaceAll("/", "\\");
    const pathBytes = Buffer.from(target, "utf16le");
    const argumentsBytes = Buffer.from("node ", "utf16le");
    const metadata = Buffer.alloc(pathBytes.length + argumentsBytes.length + 14);
    pathBytes.copy(metadata);
    metadata.writeUInt16LE(34, pathBytes.length);
    argumentsBytes.copy(metadata, pathBytes.length + 4);
    metadata.writeUInt32LE(pathBytes.length, metadata.length - 10);
    metadata.writeUInt32LE(argumentsBytes.length, metadata.length - 6);
    metadata.writeUInt16LE((2739 << 4) | 7, metadata.length - 2);
    writeFileSync(binary, "MZ", { mode: 0o755 });
    writeFileSync(join(binaryDir, "pi.bunx"), metadata);
  } else {
    symlinkSync(relative(binaryDir, cli), binary);
  }
  return binary;
}
