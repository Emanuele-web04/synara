import { describe, expect, it } from "vitest";
import { parseSocialLinkDrafts, seedSocialLinkDrafts } from "./socialLinkDrafts";

describe("social link drafts", () => {
  it("seeds every platform, empty when unset", () => {
    expect(seedSocialLinkDrafts({ github: "ada-l", x: null })).toEqual({
      x: "",
      linkedin: "",
      github: "ada-l",
      threads: "",
      youtube: "",
    });
  });

  it("turns pasted links into usernames and reports fields that don't parse", () => {
    expect(
      parseSocialLinkDrafts({
        x: " https://x.com/ada ",
        linkedin: "",
        github: "github.com/ada-l",
        threads: "https://evil.example/@ada",
        youtube: "@adalovelace",
      }),
    ).toEqual({
      usernames: { x: "ada", github: "ada-l", youtube: "adalovelace" },
      invalid: ["threads"],
    });
  });
});
