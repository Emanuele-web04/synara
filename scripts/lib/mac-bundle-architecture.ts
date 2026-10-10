// FILE: mac-bundle-architecture.ts
// Purpose: Proves every native binary in a packaged macOS app runs on its target CPU.
// Layer: Release verification helper
// Exports: findMacBundleArchitectureMismatches for the packaged startup smoke.

import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const CPU_TYPES = new Map([
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);

function readMachOArchitectures(path: string): string[] | null {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(8);
    if (readSync(descriptor, header, 0, header.length, 0) < header.length) return null;
    const cpuName = (cpuType: number) => CPU_TYPES.get(cpuType) ?? `cpu-0x${cpuType.toString(16)}`;
    const magic = header.readUInt32BE(0);
    if (magic === 0xcffaedfe || magic === 0xcefaedfe) return [cpuName(header.readUInt32LE(4))];
    if (magic !== 0xcafebabe && magic !== 0xcafebabf) return null;
    // Java class files share the universal magic; their version reads as a large count.
    const count = header.readUInt32BE(4);
    if (count === 0 || count > 20) return null;
    const entrySize = magic === 0xcafebabe ? 20 : 32;
    const table = Buffer.alloc(count * entrySize);
    if (readSync(descriptor, table, 0, table.length, header.length) < table.length) return null;
    return Array.from({ length: count }, (_, index) =>
      cpuName(table.readUInt32BE(index * entrySize)),
    );
  } finally {
    closeSync(descriptor);
  }
}

// Release CI cross-builds the Intel app on Apple Silicon, and the startup smoke
// launches only some of its binaries. Each Mach-O must carry the target slice,
// except prebuilds a package files under another darwin-<arch> directory.
export function findMacBundleArchitectureMismatches(appBundle: string, arch: string): string[] {
  const mismatches: string[] = [];
  const pending = [appBundle];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      if (!entry.isFile()) continue;
      const architectures = readMachOArchitectures(path);
      if (!architectures) continue;
      const bundlePath = relative(appBundle, path);
      const expected =
        bundlePath
          .split(sep)
          .map((segment) => /^darwin-(arm64|x64)$/.exec(segment)?.[1])
          .findLast((declared) => declared !== undefined) ?? arch;
      if (!architectures.includes(expected))
        mismatches.push(`${bundlePath} (${architectures.join(", ")}; expected ${expected})`);
    }
  }
  return mismatches.toSorted();
}
