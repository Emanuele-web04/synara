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
import { describe, expect, it } from "vitest";

import {
  buildGitCloneCommand,
  buildTokenizedRepoUrl,
  isTokenizableHttpsUrl,
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
