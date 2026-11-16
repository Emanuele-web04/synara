// FILE: markdownPlainText.test.ts
// Purpose: Verifies the Markdown-to-one-line reduction and grapheme-safe cap shared by
//          notification bodies and thread reply previews.
// Layer: Shared runtime utility tests

import { describe, expect, it } from "vitest";
import { markdownToPlainText, truncatePlainText } from "./markdownPlainText";

describe("markdownToPlainText", () => {
  it("drops headings, emphasis, list markers and link targets, keeping readable text", () => {
    expect(
      markdownToPlainText(
        "## Summary\n\nFixed **6** off-scale paddings across the _settings_ screens:\n- [x] `SettingsView`\n- See [the PR](https://github.com/acme/app/pull/2186)",
      ),
    ).toBe(
      "Summary Fixed 6 off-scale paddings across the settings screens: · SettingsView · See the PR",
    );
  });

  it("removes code-fence markup but keeps the code as text", () => {
    expect(markdownToPlainText("Run this:\n```bash\nbun run test\n```\nThen ship.")).toBe(
      "Run this: bun run test Then ship.",
    );
  });

  it("collapses every run of whitespace and newlines into one space and trims", () => {
    expect(markdownToPlainText("  first line\r\n\r\n\tsecond   line \n")).toBe(
      "first line second line",
    );
  });

  it("drops images and returns an empty string when nothing readable is left", () => {
    expect(markdownToPlainText("![screenshot](./shot.png)")).toBe("");
    expect(markdownToPlainText("![before](./a.png)\n\n![after](./b.png)")).toBe("");
    expect(markdownToPlainText(" \n\t ")).toBe("");
  });
});

describe("truncatePlainText", () => {
  it("returns text within the cap unchanged", () => {
    expect(truncatePlainText("All four PRs are merged.", 24)).toBe("All four PRs are merged.");
  });

  it("caps at the limit, ellipsis included, without a dangling space", () => {
    const capped = truncatePlainText("All four PRs are merged into main.", 18);
    expect(capped).toBe("All four PRs are…");
    expect(capped.length).toBeLessThanOrEqual(18);
  });

  it("never splits a grapheme: emoji, ZWJ sequences, flags and combining marks stay whole", () => {
    const family = "👨‍👩‍👧";
    expect(truncatePlainText(`ab${family}cd`, 6)).toBe("ab…");
    expect(truncatePlainText(`ab${family}cd`, 11)).toBe(`ab${family}…`);
    expect(truncatePlainText("ok 🇮🇹🇮🇹", 6)).toBe("ok…");
    expect(truncatePlainText("ok 🇮🇹🇮🇹", 8)).toBe("ok 🇮🇹…");
    expect(truncatePlainText("café au lait", 6)).toBe("café…");
  });
});
