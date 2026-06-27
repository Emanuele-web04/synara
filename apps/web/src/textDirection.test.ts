import { describe, expect, it } from "vitest";

import { resolveTextDirectionForContent } from "./textDirection";

describe("resolveTextDirectionForContent", () => {
  it("resolves rtl when the first strong letter is Hebrew", () => {
    expect(resolveTextDirectionForContent("  123?! שלום from Synara")).toBe("rtl");
  });

  it("resolves rtl when the first strong letter is Arabic", () => {
    expect(resolveTextDirectionForContent("\n- مرحبا with code `src/app.ts`")).toBe("rtl");
  });

  it("keeps ltr when English appears before RTL text", () => {
    expect(resolveTextDirectionForContent("Fix this ואז תסביר בעברית")).toBe("ltr");
  });

  it("falls back to ltr when content has no strong letters", () => {
    expect(resolveTextDirectionForContent("  123 -- ```")).toBe("ltr");
  });
});
