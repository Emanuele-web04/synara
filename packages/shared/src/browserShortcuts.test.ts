import { describe, expect, it } from "vitest";

import { isBrowserCopyLinkChord } from "./browserShortcuts";

describe("isBrowserCopyLinkChord", () => {
  it("matches Cmd+Shift+C on macOS only", () => {
    expect(
      isBrowserCopyLinkChord({ meta: true, ctrl: false, shift: true, alt: false, key: "c" }, true),
    ).toBe(true);
    expect(
      isBrowserCopyLinkChord({ meta: true, ctrl: false, shift: true, alt: false, key: "c" }, false),
    ).toBe(false);
  });

  it("matches Ctrl+Shift+C off macOS only", () => {
    expect(
      isBrowserCopyLinkChord({ meta: false, ctrl: true, shift: true, alt: false, key: "C" }, false),
    ).toBe(true);
    expect(
      isBrowserCopyLinkChord({ meta: false, ctrl: true, shift: true, alt: false, key: "C" }, true),
    ).toBe(false);
  });

  it("rejects alt, missing shift, and unrelated keys", () => {
    expect(
      isBrowserCopyLinkChord({ meta: true, ctrl: false, shift: true, alt: true, key: "c" }, true),
    ).toBe(false);
    expect(
      isBrowserCopyLinkChord({ meta: true, ctrl: false, shift: false, alt: false, key: "c" }, true),
    ).toBe(false);
    expect(
      isBrowserCopyLinkChord({ meta: true, ctrl: false, shift: true, alt: false, key: "v" }, true),
    ).toBe(false);
  });
});
