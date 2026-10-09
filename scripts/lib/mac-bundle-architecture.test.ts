import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findMacBundleArchitectureMismatches } from "./mac-bundle-architecture.ts";

const X64 = 0x01000007;
const ARM64 = 0x0100000c;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function thin(cpuType: number): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpuType, 4);
  return header;
}

function universal(...cpuTypes: number[]): Buffer {
  const header = Buffer.alloc(8 + cpuTypes.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(cpuTypes.length, 4);
  cpuTypes.forEach((cpuType, index) => header.writeUInt32BE(cpuType, 8 + index * 20));
  return header;
}

function appWith(files: Record<string, Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "synara-mac-arch-test-"));
  roots.push(root);
  const app = join(root, "Synara.app");
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    writeFileSync(join(app, path), bytes);
  }
  return app;
}

describe("packaged macOS architecture", () => {
  it("rejects a host-only helper in a cross-built Intel app", () => {
    const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41]);
    const app = appWith({
      "Contents/MacOS/Synara": thin(X64),
      "Contents/Frameworks/Electron Framework": universal(ARM64, X64),
      "Contents/Resources/helper": thin(ARM64),
      "Contents/Resources/node_modules/node-pty/prebuilds/darwin-arm64/pty.node": thin(ARM64),
      "Contents/Resources/node_modules/node-pty/prebuilds/darwin-x64/pty.node": thin(ARM64),
      "Contents/Resources/Example.class": javaClass,
      "Contents/Resources/readme.txt": Buffer.from("not native"),
    });
    symlinkSync("helper", join(app, "Contents/Resources/helper-link"));

    expect(findMacBundleArchitectureMismatches(app, "x64")).toEqual([
      "Contents/Resources/helper (arm64; expected x64)",
      "Contents/Resources/node_modules/node-pty/prebuilds/darwin-x64/pty.node (arm64; expected x64)",
    ]);
    expect(findMacBundleArchitectureMismatches(app, "arm64")).toEqual([
      "Contents/MacOS/Synara (x64; expected arm64)",
      "Contents/Resources/node_modules/node-pty/prebuilds/darwin-x64/pty.node (arm64; expected x64)",
    ]);
  });
});
