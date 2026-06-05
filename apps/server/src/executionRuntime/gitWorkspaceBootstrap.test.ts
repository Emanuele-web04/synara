/**
 * gitWorkspaceBootstrap unit tests (pure builders).
 *
 * Covers the token-folding + clone-command construction in isolation: that a
 * token is folded into a GitHub HTTPS URL, that a non-tokenizable URL is left
 * alone, and that the clone command clones with the tokenized URL, strips the
 * token back out of `.git/config`, checks out the ref, and never embeds the
 * token verbatim in the visible command line.
 *
 * @module gitWorkspaceBootstrap.test
 */
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  buildGitCloneCommand,
  buildPostCloneCommand,
  buildTokenizedRepoUrl,
  isTokenizableHttpsUrl,
  POST_CLONE_AUTO_DETECT,
} from "./gitWorkspaceBootstrap.ts";

const decodeArg = (b64: string): string => Buffer.from(b64, "base64").toString("utf8");

describe("buildTokenizedRepoUrl", () => {
  it("folds a token into an https github URL as x-access-token userinfo", () => {
    const url = buildTokenizedRepoUrl("https://github.com/Tbsheff/synara.git", "gho_secrettoken");
    expect(url).toBe("https://x-access-token:gho_secrettoken@github.com/Tbsheff/synara.git");
  });

  it("leaves the URL unchanged when no token is supplied", () => {
    const url = "https://github.com/Tbsheff/synara.git";
    expect(buildTokenizedRepoUrl(url, null)).toBe(url);
    expect(buildTokenizedRepoUrl(url, "   ")).toBe(url);
  });

  it("leaves a non-github / ssh URL unchanged even with a token", () => {
    expect(buildTokenizedRepoUrl("git@github.com:Tbsheff/synara.git", "tok")).toBe(
      "git@github.com:Tbsheff/synara.git",
    );
    expect(buildTokenizedRepoUrl("https://gitlab.com/x/y.git", "tok")).toBe(
      "https://gitlab.com/x/y.git",
    );
  });
});

describe("isTokenizableHttpsUrl", () => {
  it("accepts only https github.com URLs", () => {
    expect(isTokenizableHttpsUrl("https://github.com/a/b.git")).toBe(true);
    expect(isTokenizableHttpsUrl("http://github.com/a/b.git")).toBe(false);
    expect(isTokenizableHttpsUrl("git@github.com:a/b.git")).toBe(false);
    expect(isTokenizableHttpsUrl("not a url")).toBe(false);
  });
});

describe("buildGitCloneCommand", () => {
  const tokenizedUrl = "https://x-access-token:gho_secret@github.com/Tbsheff/synara.git";
  const cleanUrl = "https://github.com/Tbsheff/synara.git";
  const command = buildGitCloneCommand({
    tokenizedUrl,
    cleanUrl,
    targetPath: "/root/synara",
    ref: "main",
  });

  it("runs under bash -lc with the URLs/target/ref as base64 args", () => {
    expect(command.command).toBe("bash");
    expect(command.args[0]).toBe("-lc");
    const [, , a0, a1, a2, a3] = command.args;
    expect(decodeArg(a0 as string)).toBe(tokenizedUrl);
    expect(decodeArg(a1 as string)).toBe(cleanUrl);
    expect(decodeArg(a2 as string)).toBe("/root/synara");
    expect(decodeArg(a3 as string)).toBe("main");
  });

  it("clones, strips the token from origin, and checks out the ref", () => {
    const script = command.args[1] as string;
    expect(script).toContain("git clone");
    // The clean URL is written back to origin so the token is not persisted.
    expect(script).toContain("remote set-url origin");
    expect(script).toContain('checkout -B "$ref"');
  });

  it("resolves the ref to its origin commit, not the cloned default HEAD", () => {
    const script = command.args[1] as string;
    // A feature branch must check out origin/<ref> (via fetch + FETCH_HEAD), gated
    // by ls-remote so a not-yet-pushed branch still falls back to HEAD. The fetch
    // runs before the token is stripped so a private fetch authenticates.
    expect(script).toContain("ls-remote");
    expect(script).toContain('checkout -B "$ref" FETCH_HEAD');
    expect(script.indexOf("FETCH_HEAD")).toBeLessThan(script.indexOf("remote set-url origin"));
  });

  it("never embeds the token verbatim on the visible command line", () => {
    // The script and its non-arg positions must not contain the raw token; the
    // only place the tokenized URL appears is the opaque base64 positional arg.
    const visible = [command.command, command.args[0], command.args[1]].join(" ");
    expect(visible).not.toContain("gho_secret");
    expect(visible).not.toContain(tokenizedUrl);
  });
});

describe("buildPostCloneCommand", () => {
  it("returns null for a blank command (default OFF)", () => {
    expect(buildPostCloneCommand("", "/root/synara")).toBeNull();
    expect(buildPostCloneCommand("   ", "/root/synara")).toBeNull();
  });

  it("runs a literal command in the clone dir via eval, with dir/cmd as base64 args", () => {
    const exec = buildPostCloneCommand("pnpm install --frozen-lockfile", "/root/synara");
    expect(exec).not.toBeNull();
    const built = exec as NonNullable<typeof exec>;
    expect(built.command).toBe("bash");
    expect(built.args[0]).toBe("-lc");
    const script = built.args[1] as string;
    expect(script).toContain('cd "$dir"');
    expect(script).toContain('eval "$cmd"');
    // dir is $0, command is $1.
    expect(decodeArg(built.args[2] as string)).toBe("/root/synara");
    expect(decodeArg(built.args[3] as string)).toBe("pnpm install --frozen-lockfile");
  });

  it("never embeds the raw command on the visible command line", () => {
    const exec = buildPostCloneCommand("echo SENTINEL_VALUE", "/root/synara");
    const built = exec as NonNullable<typeof exec>;
    const visible = [built.command, built.args[0], built.args[1]].join(" ");
    expect(visible).not.toContain("SENTINEL_VALUE");
  });

  it("auto-detects a package manager from a lockfile when set to 'auto'", () => {
    const exec = buildPostCloneCommand(POST_CLONE_AUTO_DETECT, "/root/synara");
    expect(exec).not.toBeNull();
    const built = exec as NonNullable<typeof exec>;
    const script = built.args[1] as string;
    // Detect precedence: bun, then pnpm, then npm; no lockfile is a no-op echo.
    expect(script).toContain("bun.lock");
    expect(script).toContain("bun install");
    expect(script).toContain("pnpm-lock.yaml");
    expect(script).toContain("pnpm install --frozen-lockfile");
    expect(script).toContain("package-lock.json");
    expect(script).toContain("npm ci");
    expect(script).toContain("skipping dependency install");
    // No command arg is needed for the auto-detect path; only the dir rides.
    expect(decodeArg(built.args[2] as string)).toBe("/root/synara");
    expect(built.args[3]).toBeUndefined();
    // Run the built script through `bash -n`: substring checks alone passed even
    // when the lines were joined without separators into an unparseable script.
    expect(() => execFileSync("bash", ["-n", "-c", script])).not.toThrow();
  });

  it("treats 'auto' case-insensitively", () => {
    const exec = buildPostCloneCommand("AUTO", "/root/synara");
    const built = exec as NonNullable<typeof exec>;
    expect(built.args[1]).toContain("bun.lock");
  });
});
