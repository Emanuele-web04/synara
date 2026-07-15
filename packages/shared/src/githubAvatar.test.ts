import { describe, expect, it } from "vitest";

import { githubAvatarUrlForLogin } from "./githubAvatar";

describe("githubAvatarUrlForLogin", () => {
  it("derives the login-addressed avatar URL", () => {
    expect(githubAvatarUrlForLogin("octocat")).toBe(
      "https://avatars.githubusercontent.com/octocat?size=64",
    );
  });

  it("URL-encodes logins with reserved characters (bot accounts)", () => {
    expect(githubAvatarUrlForLogin("github-actions[bot]")).toBe(
      "https://avatars.githubusercontent.com/github-actions%5Bbot%5D?size=64",
    );
  });

  it("trims whitespace before deriving", () => {
    expect(githubAvatarUrlForLogin("  octocat  ")).toBe(
      "https://avatars.githubusercontent.com/octocat?size=64",
    );
  });

  it("returns null for GitHub App actors and empty logins", () => {
    expect(githubAvatarUrlForLogin("app/dependabot")).toBeNull();
    expect(githubAvatarUrlForLogin("")).toBeNull();
    expect(githubAvatarUrlForLogin("   ")).toBeNull();
    expect(githubAvatarUrlForLogin(null)).toBeNull();
    expect(githubAvatarUrlForLogin(undefined)).toBeNull();
  });
});
