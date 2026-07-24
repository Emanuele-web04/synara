import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveRealBinary } from "./binaryResolution.ts";

let base: string;
let shimDir: string;
let realDir: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "synara-binres-test-"));
  shimDir = path.join(base, "shims");
  realDir = path.join(base, "real");
  fs.mkdirSync(shimDir);
  fs.mkdirSync(realDir);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function writeExecutable(dir: string, name: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "#!/bin/sh\n");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

describe("resolveRealBinary", () => {
  it("skips the shim directory and finds the real binary", () => {
    writeExecutable(shimDir, "codex");
    const real = writeExecutable(realDir, "codex");
    const resolved = resolveRealBinary({
      command: "codex",
      pathEnv: [shimDir, realDir].join(path.delimiter),
      shimDir,
    });
    expect(resolved).toBe(fs.realpathSync(real));
  });

  it("rejects candidates that canonicalize into the shim directory", () => {
    const shim = writeExecutable(shimDir, "codex");
    const linkDir = path.join(base, "links");
    fs.mkdirSync(linkDir);
    fs.symlinkSync(shim, path.join(linkDir, "codex"));
    const resolved = resolveRealBinary({ command: "codex", pathEnv: linkDir, shimDir });
    expect(resolved).toBeNull();
  });

  it("skips non-executable files on unix", () => {
    fs.writeFileSync(path.join(realDir, "codex"), "not executable");
    fs.chmodSync(path.join(realDir, "codex"), 0o644);
    const resolved = resolveRealBinary({
      command: "codex",
      pathEnv: realDir,
      shimDir,
      platform: "linux",
    });
    expect(resolved).toBeNull();
  });

  it("returns null when the binary is missing", () => {
    expect(resolveRealBinary({ command: "codex", pathEnv: realDir, shimDir })).toBeNull();
  });
});
