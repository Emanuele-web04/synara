// FILE: managedTerminalWrappers.test.ts
// Purpose: Pin how the managed terminal wrappers locate the CLIs they shadow. The lookup runs
//          against the caller's `baseEnv`, not this process's, because the wrapper is written for
//          the terminal that env describes.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyManagedTerminalAgentWrapperEnv,
  prepareManagedTerminalWrappers,
} from "./managedTerminalWrappers.ts";

// The whole feature short-circuits on Windows, so there is nothing to pin there.
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

let dir: string;
let binDir: string;
let rootDir: string;
let zshRootDir: string;

function installFakeCli(name: string): string {
  const filePath = path.join(binDir, name);
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return filePath;
}

function prepare(baseEnv: NodeJS.ProcessEnv) {
  return prepareManagedTerminalWrappers({ baseEnv, rootDir, zshRootDir });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "synara-managed-wrappers-"));
  binDir = path.join(dir, "bin");
  rootDir = path.join(dir, "managed");
  zshRootDir = path.join(dir, "zsh");
  mkdirSync(binDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describeOnPosix("prepareManagedTerminalWrappers", () => {
  it("resolves each CLI through the supplied environment's PATH", () => {
    const codexPath = installFakeCli("codex");
    const claudePath = installFakeCli("claude");

    const state = prepare({ PATH: binDir });

    expect(state.targetPathByCliKind).toEqual({ codex: codexPath, claude: claudePath });
    expect(state.binDir).toBe(rootDir);
  });

  it("wraps only the CLIs that are actually installed", () => {
    const codexPath = installFakeCli("codex");

    const state = prepare({ PATH: binDir });

    expect(state.targetPathByCliKind).toEqual({ codex: codexPath });
  });

  it("does nothing when the supplied environment cannot see either CLI", () => {
    installFakeCli("codex");

    // A PATH that does not contain the bin directory must not fall back to this process's PATH,
    // which is exactly where a real `codex` would be found on a developer machine.
    const state = prepare({ PATH: path.join(dir, "empty") });

    expect(state.targetPathByCliKind).toEqual({});
    expect(state.binDir).toBeNull();
    expect(state.zshDir).toBeNull();
  });

  it("ignores a file on PATH that is not executable", () => {
    writeFileSync(path.join(binDir, "codex"), "#!/bin/sh\n", { mode: 0o644 });

    expect(prepare({ PATH: binDir }).targetPathByCliKind).toEqual({});
  });

  it("reads PATH under any capitalization", () => {
    const codexPath = installFakeCli("codex");

    expect(prepare({ Path: binDir }).targetPathByCliKind).toEqual({ codex: codexPath });
    expect(prepare({ path: binDir }).targetPathByCliKind).toEqual({ codex: codexPath });
  });

  it("points the generated wrapper at the resolved binary", () => {
    const codexPath = installFakeCli("codex");

    const state = prepare({ PATH: binDir });

    const wrapper = readFileSync(path.join(rootDir, "codex"), "utf8");
    expect(wrapper).toContain(codexPath);
    // The wrapper must not re-enter itself: it shadows `codex` on PATH.
    expect(state.targetPathByCliKind.codex).not.toBe(path.join(rootDir, "codex"));
  });

  it("prepends the managed bin directory to the PATH key the env already uses", () => {
    installFakeCli("codex");
    const state = prepare({ Path: binDir });

    const env = applyManagedTerminalAgentWrapperEnv({ Path: binDir }, state);

    expect(env.Path?.split(path.delimiter)[0]).toBe(rootDir);
    expect(env.PATH).toBeUndefined();
    expect(env.SYNARA_MANAGED_BIN_DIR).toBe(rootDir);
  });
});
