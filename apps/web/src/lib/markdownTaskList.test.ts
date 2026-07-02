import { describe, expect, it } from "vitest";

import { toggleMarkdownTaskMarker } from "./markdownTaskList";

describe("toggleMarkdownTaskMarker", () => {
  it("checks an unchecked task", () => {
    const contents = "# Todo\n\n- [ ] write tests\n- [x] ship it\n";
    expect(toggleMarkdownTaskMarker(contents, 3, true)).toBe(
      "# Todo\n\n- [x] write tests\n- [x] ship it\n",
    );
  });

  it("unchecks a checked task, including uppercase X", () => {
    expect(toggleMarkdownTaskMarker("- [x] done", 1, false)).toBe("- [ ] done");
    expect(toggleMarkdownTaskMarker("- [X] done", 1, false)).toBe("- [ ] done");
  });

  it("handles every bullet style", () => {
    expect(toggleMarkdownTaskMarker("* [ ] star", 1, true)).toBe("* [x] star");
    expect(toggleMarkdownTaskMarker("+ [ ] plus", 1, true)).toBe("+ [x] plus");
    expect(toggleMarkdownTaskMarker("1. [ ] ordered", 1, true)).toBe("1. [x] ordered");
    expect(toggleMarkdownTaskMarker("2) [ ] paren", 1, true)).toBe("2) [x] paren");
  });

  it("handles nested and blockquoted task items", () => {
    expect(toggleMarkdownTaskMarker("    - [ ] nested", 1, true)).toBe("    - [x] nested");
    expect(toggleMarkdownTaskMarker("> - [ ] quoted", 1, true)).toBe("> - [x] quoted");
    expect(toggleMarkdownTaskMarker("> > - [ ] deep", 1, true)).toBe("> > - [x] deep");
  });

  it("preserves the rest of the line and the other lines verbatim", () => {
    const contents = "before\n- [ ] task with [link](x) and `code`\nafter";
    expect(toggleMarkdownTaskMarker(contents, 2, true)).toBe(
      "before\n- [x] task with [link](x) and `code`\nafter",
    );
  });

  it("returns null when the line is not a task item (stale line number)", () => {
    expect(toggleMarkdownTaskMarker("plain text", 1, true)).toBeNull();
    expect(toggleMarkdownTaskMarker("- regular bullet", 1, true)).toBeNull();
    expect(toggleMarkdownTaskMarker("[ ] no bullet", 1, true)).toBeNull();
  });

  it("returns null for an out-of-range line", () => {
    expect(toggleMarkdownTaskMarker("- [ ] only line", 0, true)).toBeNull();
    expect(toggleMarkdownTaskMarker("- [ ] only line", 5, true)).toBeNull();
  });
});
