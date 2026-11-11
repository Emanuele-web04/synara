// FILE: install-git-hooks.test.ts
// Purpose: Verifies the pre-push hook wiring is developer-only and the hook's push handling.
// Layer: Repository tooling tests
// Depends on: scripts/install-git-hooks.ts, .githooks/pre-push and a `git` executable.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { HOOKS_PATH, installGitHooks } from "./install-git-hooks";

const hookSource = fileURLToPath(new URL("../.githooks/pre-push", import.meta.url));
const temporary: string[] = [];
const developer = { CI: undefined };

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "synara-git-hooks-"));
  temporary.push(directory);
  return directory;
}

function makeCheckout(): string {
  const root = makeDirectory();
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, HOOKS_PATH));
  copyFileSync(hookSource, join(root, HOOKS_PATH, "pre-push"));
  return root;
}

function hooksPath(root: string): string {
  const result = spawnSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("installGitHooks", () => {
  it("enables the tracked hooks once in a developer checkout", () => {
    const root = makeCheckout();
    expect(installGitHooks(root, developer)).toEqual({ action: "installed" });
    expect(hooksPath(root)).toBe(HOOKS_PATH);
    expect(installGitHooks(root, developer)).toEqual({ action: "unchanged" });
  });

  it("is a no-op in CI, including providers that name themselves in CI", () => {
    for (const CI of ["true", "1", "woodpecker"]) {
      const root = makeCheckout();
      expect(installGitHooks(root, { CI })).toEqual({ action: "skipped", reason: "CI" });
      expect(hooksPath(root)).toBe("");
    }
    expect(installGitHooks(makeCheckout(), { CI: "false" })).toEqual({ action: "installed" });
  });

  it("keeps a hooks directory the clone owner already chose", () => {
    const root = makeCheckout();
    execFileSync("git", ["config", "core.hooksPath", ".git/hooks"], { cwd: root });
    expect(installGitHooks(root, developer).action).toBe("skipped");
    expect(hooksPath(root)).toBe(".git/hooks");
  });

  it("leaves copies that are not their own repository root untouched", () => {
    const outside = makeDirectory();
    mkdirSync(join(outside, HOOKS_PATH));
    writeFileSync(join(outside, HOOKS_PATH, "pre-push"), "");
    expect(installGitHooks(outside, developer).action).toBe("skipped");

    const parent = makeCheckout();
    const staged = join(parent, "staging");
    mkdirSync(join(staged, HOOKS_PATH), { recursive: true });
    writeFileSync(join(staged, HOOKS_PATH, "pre-push"), "");
    expect(installGitHooks(staged, developer)).toEqual({
      action: "skipped",
      reason: "not the repository root",
    });
    expect(hooksPath(parent)).toBe("");

    const withoutHook = makeCheckout();
    rmSync(join(withoutHook, HOOKS_PATH), { recursive: true });
    expect(installGitHooks(withoutHook, developer).action).toBe("skipped");
  });
});

describe.skipIf(process.platform === "win32")("pre-push hook", () => {
  const zero = "0".repeat(40);
  const oid = "1".repeat(40);

  function push(stdin: string, bun: "pass" | "fail" | "missing") {
    const root = makeCheckout();
    const bin = makeDirectory();
    const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    symlinkSync(gitPath, join(bin, "git"));
    if (bun !== "missing") {
      // Records each `bun run <script>` call and passes or fails it.
      writeFileSync(
        join(bin, "bun"),
        `#!/bin/sh\necho "$*" >> "${join(bin, "calls")}"\nexit ${bun === "pass" ? 0 : 1}\n`,
      );
      chmodSync(join(bin, "bun"), 0o755);
    }
    const result = spawnSync("/bin/sh", [join(root, HOOKS_PATH, "pre-push"), "origin", "url"], {
      cwd: root,
      input: stdin,
      encoding: "utf8",
      env: { PATH: bin },
    });
    const calls = spawnSync("/bin/sh", ["-c", `cat "${join(bin, "calls")}" 2>/dev/null`], {
      encoding: "utf8",
      env: { PATH: "/bin:/usr/bin" },
    }).stdout;
    return { status: result.status, calls: calls.trim().split("\n").filter(Boolean) };
  }

  const update = `refs/heads/topic ${oid} refs/heads/topic ${zero}\n`;

  it("runs fmt:check then lint and blocks the push when either fails", () => {
    expect(push(update, "pass")).toEqual({ status: 0, calls: ["run fmt:check", "run lint"] });
    expect(push(update, "fail")).toEqual({ status: 1, calls: ["run fmt:check"] });
  });

  it("skips branch deletions and machines without bun", () => {
    expect(push(`(delete) ${zero} refs/heads/old ${oid}\n`, "fail")).toEqual({
      status: 0,
      calls: [],
    });
    expect(push(update, "missing")).toEqual({ status: 0, calls: [] });
  });
});
