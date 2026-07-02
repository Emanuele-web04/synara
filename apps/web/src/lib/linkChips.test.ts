import { describe, expect, it } from "vitest";

import {
  describeLinkChip,
  normalizeComposerLinkUrl,
  parseBareComposerLink,
  trimTrailingLinkPunctuation,
} from "./linkChips";

describe("parseBareComposerLink", () => {
  it("returns the URL when the whole text is one bare link", () => {
    expect(parseBareComposerLink("https://github.com/Emanuele-web04/synara")).toBe(
      "https://github.com/Emanuele-web04/synara",
    );
  });

  it("ignores surrounding whitespace and trailing punctuation", () => {
    expect(parseBareComposerLink("  https://example.com/path.  ")).toBe("https://example.com/path");
  });

  it("normalizes a bare domain link so composer chips can fetch favicons", () => {
    expect(parseBareComposerLink("linear.app/team/issue/ENG-12")).toBe(
      "https://linear.app/team/issue/ENG-12",
    );
  });

  it("returns null for prose, multiple tokens, or non-URLs", () => {
    expect(parseBareComposerLink("see https://example.com here")).toBeNull();
    expect(parseBareComposerLink("https://a.com https://b.com")).toBeNull();
    expect(parseBareComposerLink("just text")).toBeNull();
    expect(parseBareComposerLink("AGENTS.md")).toBeNull();
    expect(parseBareComposerLink("")).toBeNull();
  });
});

describe("normalizeComposerLinkUrl", () => {
  it("keeps http(s) URLs unchanged", () => {
    expect(normalizeComposerLinkUrl("https://linear.app/team/issue/ENG-12")).toBe(
      "https://linear.app/team/issue/ENG-12",
    );
  });

  it("adds https:// for public-looking bare domains", () => {
    expect(normalizeComposerLinkUrl("linear.app/team/issue/ENG-12")).toBe(
      "https://linear.app/team/issue/ENG-12",
    );
    expect(normalizeComposerLinkUrl("linear.app")).toBe("https://linear.app");
  });

  it("does not treat common local filenames as bare domains", () => {
    expect(normalizeComposerLinkUrl("AGENTS.md")).toBeNull();
    expect(normalizeComposerLinkUrl("index.ts")).toBeNull();
  });

  it("avoids uncommon single-token dotted prose unless it has a path", () => {
    expect(normalizeComposerLinkUrl("foo.bar")).toBeNull();
    expect(normalizeComposerLinkUrl("foo.bar/docs")).toBe("https://foo.bar/docs");
  });
});

describe("describeLinkChip", () => {
  it("shortens GitHub pull request URLs to owner/repo#number", () => {
    expect(describeLinkChip("https://github.com/Emanuele-web04/synara/pull/155")).toEqual({
      label: "Emanuele-web04/synara#155",
      isGitHub: true,
    });
  });

  it("shortens GitHub issue URLs to owner/repo#number", () => {
    expect(describeLinkChip("https://github.com/openai/codex/issues/42")).toEqual({
      label: "openai/codex#42",
      isGitHub: true,
    });
  });

  it("keeps the pull reference when extra path segments follow", () => {
    expect(describeLinkChip("https://github.com/openai/codex/pull/9/files")).toEqual({
      label: "openai/codex#9",
      isGitHub: true,
    });
  });

  it("shortens GitHub commit URLs to a 7-character sha", () => {
    expect(describeLinkChip("https://github.com/openai/codex/commit/abcdef1234567890")).toEqual({
      label: "openai/codex@abcdef1",
      isGitHub: true,
    });
  });

  it("shortens GitHub repository roots to owner/repo and strips .git", () => {
    expect(describeLinkChip("https://github.com/openai/codex")).toEqual({
      label: "openai/codex",
      isGitHub: true,
    });
    expect(describeLinkChip("https://github.com/openai/codex.git")).toEqual({
      label: "openai/codex",
      isGitHub: true,
    });
  });

  it("shortens GitHub user/org URLs to the owner", () => {
    expect(describeLinkChip("https://github.com/openai")).toEqual({
      label: "openai",
      isGitHub: true,
    });
  });

  it("treats uncommon GitHub paths as a plain globe link", () => {
    expect(describeLinkChip("https://github.com/openai/codex/tree/main")).toEqual({
      label: "github.com/openai/codex/tree/main",
      isGitHub: false,
    });
  });

  it("renders non-GitHub URLs as a de-schemed globe link", () => {
    expect(describeLinkChip("https://linear.app/team/issue/ENG-12")).toEqual({
      label: "linear.app/team/issue/ENG-12",
      isGitHub: false,
    });
    expect(describeLinkChip("https://www.example.com/")).toEqual({
      label: "example.com",
      isGitHub: false,
    });
  });

  it("recognizes bare GitHub domains after normalization", () => {
    expect(describeLinkChip("github.com/openai/codex/pull/12")).toEqual({
      label: "openai/codex#12",
      isGitHub: true,
    });
  });
});

describe("trimTrailingLinkPunctuation", () => {
  it("removes trailing sentence punctuation", () => {
    expect(trimTrailingLinkPunctuation("https://example.com.")).toBe("https://example.com");
    expect(trimTrailingLinkPunctuation("https://example.com/path),")).toBe(
      "https://example.com/path)",
    );
  });

  it("leaves clean URLs untouched", () => {
    expect(trimTrailingLinkPunctuation("https://github.com/openai/codex/pull/1")).toBe(
      "https://github.com/openai/codex/pull/1",
    );
  });
});
