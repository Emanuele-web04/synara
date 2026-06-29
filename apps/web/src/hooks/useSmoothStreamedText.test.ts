import { describe, expect, it } from "vitest";

import { sliceGraphemeSafe } from "./useSmoothStreamedText";

describe("sliceGraphemeSafe", () => {
  it("does not split emoji ZWJ clusters", () => {
    const value = "A👩‍💻B";

    expect(sliceGraphemeSafe(value, 2)).toBe("A");
    expect(sliceGraphemeSafe(value, "A👩‍💻".length)).toBe("A👩‍💻");
  });

  it("does not split combining marks", () => {
    const value = "Cafe\u0301 done";

    expect(sliceGraphemeSafe(value, "Cafe".length)).toBe("Caf");
    expect(sliceGraphemeSafe(value, "Cafe\u0301".length)).toBe("Cafe\u0301");
  });
});
