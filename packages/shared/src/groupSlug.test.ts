import { describe, expect, it } from "vitest";

import { slugifyGroupTitle } from "./groupSlug";

describe("slugifyGroupTitle", () => {
  it("builds a lowercase hyphen slug from a group title", () => {
    expect(slugifyGroupTitle("Increment 2 Group")).toBe("increment-2-group");
    expect(slugifyGroupTitle("Yes, it takes all the skills!")).toBe("yes-it-takes-all-the-skills");
  });

  it("falls back when the title has no slug characters", () => {
    expect(slugifyGroupTitle("!!!")).toBe("group");
  });
});
