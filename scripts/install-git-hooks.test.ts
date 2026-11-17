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

  function push(stdin: string, node: "pass" | "fail" | "missing", trackedHook = true) {
    const root = makeCheckout();
    const prePush = defaultPrePushPath(root);
    expect(installGitHooks(root, developer)).toEqual({ action: "installed" });
    if (!trackedHook) rmSync(join(root, trackedHooks), { recursive: true });
    const bin = makeDirectory();
    const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    symlinkSync(gitPath, join(bin, "git"));
    if (node !== "missing") {
      // Records each `node <script>` call with the refs it read, then passes or fails.
      writeFileSync(
        join(bin, "node"),
        `#!/bin/sh\necho "$* $(/bin/cat)" >> "${join(bin, "calls")}"\nexit ${node === "pass" ? 0 : 1}\n`,
      );
      chmodSync(join(bin, "node"), 0o755);
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

  const update = `refs/heads/topic ${oid} refs/heads/topic ${zero}`;

  it("hands the pushed refs to the changed-file check and blocks the push when it fails", () => {
    const call = `scripts/pre-push-check.ts ${update}`;
    expect(push(`${update}\n`, "pass")).toEqual({ status: 0, calls: [call] });
    expect(push(`${update}\n`, "fail")).toEqual({ status: 1, calls: [call] });
  });

  it("blocks instead of silently skipping when node is missing", () => {
    expect(push(`${update}\n`, "missing").status).toBe(1);
  });

  it("skips branches where the tracked hook is absent", () => {
    expect(push(`${update}\n`, "fail", false)).toEqual({ status: 0, calls: [] });
  });

  function checkoutWithRealHook() {
    const root = makeCheckout();
    expect(installGitHooks(root, developer)).toEqual({ action: "installed" });
    mkdirSync(join(root, "scripts"));
    for (const file of ["pre-push-check.ts", "typecheck.ts"]) {
      copyFileSync(fileURLToPath(new URL(file, import.meta.url)), join(root, "scripts", file));
    }
    writeFileSync(
      join(root, "tsconfig.check.json"),
      JSON.stringify({ references: [{ path: "apps/server" }, { path: "scripts" }] }),
    );
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["oxfmt", "oxlint", "tsrs"]) {
      writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${tool}.log\n`, {
        mode: 0o755,
      });
    }
    return root;
  }

  it("checks a Unicode path and type-checks a workspace affected by deletion on a multi-ref push", () => {
    const root = checkoutWithRealHook();
    const remote = makeDirectory();
    git(remote, "init", "--bare", "-q", "--template=");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.com");
    git(root, "switch", "-qc", "main");
    const changed = "packages/shared/éclair.ts";
    const deleted = "apps/server/old.ts";
    mkdirSync(dirname(join(root, changed)), { recursive: true });
    mkdirSync(dirname(join(root, deleted)), { recursive: true });
    writeFileSync(join(root, changed), "export const value = 1;\n");
    writeFileSync(join(root, deleted), "export const old = 1;\n");
    git(root, "add", "--", changed, deleted);
    git(root, "commit", "-qm", "initial");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-q", "--no-verify", "origin", "main", "main:cleanup");
    git(root, "switch", "-qc", "cleanup");
    git(root, "rm", "-q", "--", deleted);
    git(root, "commit", "-qm", "remove old source");

    git(root, "push", "-q", "origin", "cleanup");

    expect(readFileSync(join(root, "tsrs.log"), "utf8")).toContain("apps/server");
    expect(existsSync(join(root, "oxfmt.log"))).toBe(false);
    rmSync(join(root, "tsrs.log"));
    git(root, "switch", "-qc", "topic");
    writeFileSync(join(root, changed), "export const value = 2;\n");
    git(root, "add", "--", changed);
    git(root, "commit", "-qm", "change Unicode path");

    git(root, "push", "-q", "origin", "topic", ":cleanup");

    const paths = readFileSync(join(root, "oxfmt.log"), "utf8").normalize("NFC").split("\n");
    expect(paths).toContain(changed);
    expect(paths).not.toContain(deleted);
  });

  it("blocks the push when Git cannot enumerate the supplied object", () => {
    const root = checkoutWithRealHook();
    const result = spawnSync(defaultPrePushPath(root), ["origin", "url"], {
      cwd: root,
      input: `${update}\n`,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("git ls-tree");
  });
});
