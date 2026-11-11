// FILE: install-git-hooks.test.ts
// Purpose: Verifies the pre-push hook wiring is developer-only and the hook's push handling.
// Layer: Repository tooling tests
// Depends on: scripts/install-git-hooks.ts, .githooks/pre-push and a `git` executable.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installGitHooks } from "./install-git-hooks";

const trackedHooks = ".githooks";
const hookSource = fileURLToPath(new URL("../.githooks/pre-push", import.meta.url));
const temporary: string[] = [];
const developer = { CI: undefined };

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "synara-git-hooks-"));
  temporary.push(directory);
  return directory;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function makeCheckout(): string {
  const root = makeDirectory();
  git(root, "init", "-q", "--template=");
  mkdirSync(join(root, trackedHooks));
  copyFileSync(hookSource, join(root, trackedHooks, "pre-push"));
  return root;
}

function configuredHooksPath(root: string): string {
  const result = spawnSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

function defaultPrePushPath(root: string): string {
  return git(root, "rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push");
}

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(makeDirectory(), "gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("installGitHooks", () => {
  it("installs once from a linked worktree and preserves Git's default hook resolution", () => {
    const root = makeCheckout();
    const prePush = defaultPrePushPath(root);
    const worktree = makeDirectory();
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.com");
    git(root, "commit", "--allow-empty", "-qm", "initial");
    git(root, "worktree", "add", "--detach", "-q", worktree);
    mkdirSync(join(worktree, trackedHooks));
    copyFileSync(hookSource, join(worktree, trackedHooks, "pre-push"));

    expect(installGitHooks(worktree, developer)).toEqual({ action: "installed" });
    expect(configuredHooksPath(root)).toBe("");
    expect(defaultPrePushPath(worktree)).toBe(prePush);
    expect(installGitHooks(root, developer)).toEqual({ action: "unchanged" });
  });

  it("is a no-op in CI, including providers that name themselves in CI", () => {
    for (const CI of ["true", "1", "woodpecker"]) {
      const root = makeCheckout();
      expect(installGitHooks(root, { CI })).toEqual({ action: "skipped", reason: "CI" });
      expect(existsSync(defaultPrePushPath(root))).toBe(false);
    }
    expect(installGitHooks(makeCheckout(), { CI: "false" })).toEqual({ action: "installed" });
  });

  it("keeps a hooks directory the clone owner already chose", () => {
    const root = makeCheckout();
    git(root, "config", "core.hooksPath", ".git/hooks");
    expect(installGitHooks(root, developer).action).toBe("skipped");
    expect(configuredHooksPath(root)).toBe(".git/hooks");
  });

  it("keeps an existing pre-push hook in Git's default directory", () => {
    const root = makeCheckout();
    const prePush = defaultPrePushPath(root);
    const existing = "#!/bin/sh\nexit 1\n";
    mkdirSync(dirname(prePush), { recursive: true });
    writeFileSync(prePush, existing, { mode: 0o755 });

    expect(installGitHooks(root, developer)).toEqual({ action: "unchanged" });
    expect(defaultPrePushPath(root)).toBe(prePush);
    expect(readFileSync(prePush, "utf8")).toBe(existing);
  });

  it("leaves copies that are not their own repository root untouched", () => {
    const outside = makeDirectory();
    mkdirSync(join(outside, trackedHooks));
    writeFileSync(join(outside, trackedHooks, "pre-push"), "");
    expect(installGitHooks(outside, developer).action).toBe("skipped");

    const parent = makeCheckout();
    const staged = join(parent, "staging");
    mkdirSync(join(staged, trackedHooks), { recursive: true });
    writeFileSync(join(staged, trackedHooks, "pre-push"), "");
    expect(installGitHooks(staged, developer)).toEqual({
      action: "skipped",
      reason: "not the repository root",
    });
    expect(existsSync(defaultPrePushPath(parent))).toBe(false);

    const withoutHook = makeCheckout();
    rmSync(join(withoutHook, trackedHooks), { recursive: true });
    expect(installGitHooks(withoutHook, developer).action).toBe("skipped");
  });
});

describe.skipIf(process.platform === "win32")("pre-push hook", () => {
  const zero = "0".repeat(40);
  const oid = "1".repeat(40);

  function push(stdin: string, bun: "pass" | "fail" | "missing", trackedHook = true) {
    const root = makeCheckout();
    const prePush = defaultPrePushPath(root);
    expect(installGitHooks(root, developer)).toEqual({ action: "installed" });
    if (!trackedHook) rmSync(join(root, trackedHooks), { recursive: true });
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
    const result = spawnSync(prePush, ["origin", "url"], {
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

  it("skips branches where the tracked hook is absent", () => {
    expect(push(update, "fail", false)).toEqual({ status: 0, calls: [] });
  });
});
