import { describe, expect, it } from "vitest";

import {
  assertHotkeyChord,
  assertKeyName,
  assertSemanticAction,
  assertTypeableText,
} from "./inputVocabulary.ts";

describe("input vocabulary", () => {
  it("types printable ASCII with newline and tab, and refuses anything else", () => {
    const newline = String.fromCharCode(0x0a);
    const tab = String.fromCharCode(0x09);
    expect(() => assertTypeableText(`Hello, world!${newline}${tab}done ~\``)).not.toThrow();
    expect(() => assertTypeableText("naïve")).toThrow(/U\+00EF/);
    expect(() => assertTypeableText(`a${String.fromCharCode(7)}b`)).toThrow(/cannot type/);
  });

  it("canonicalises key names and refuses unknown ones", () => {
    expect(assertKeyName("a")).toBe("a");
    expect(assertKeyName("A")).toBe("A");
    expect(assertKeyName("Enter")).toBe("enter");
    expect(assertKeyName("Esc")).toBe("escape");
    expect(assertKeyName("Control")).toBe("control");
    expect(() => assertKeyName("key-500")).toThrow(/not one this desktop can press/);
    expect(() => assertKeyName("é")).toThrow(/not one this desktop can press/);
  });

  it("accepts one non-modifier key per chord and folds modifier spellings", () => {
    expect(assertHotkeyChord(["Control", "shift", "L"])).toEqual({
      modifiers: ["ctrl", "shift"],
      key: "L",
    });
    expect(assertHotkeyChord(["super", "command", "tab"])).toEqual({
      modifiers: ["meta"],
      key: "tab",
    });
    expect(() => assertHotkeyChord(["ctrl", "a", "b"])).toThrow(/exactly one key/);
    expect(() => assertHotkeyChord(["ctrl", "shift"])).toThrow(/modifiers alone/);
    expect(() => assertHotkeyChord(["capslock", "a"])).toThrow(/cannot be held/);
  });

  it("performs only the semantic actions of the desktop's family", () => {
    expect(() => assertSemanticAction("linux", "activate")).not.toThrow();
    expect(() => assertSemanticAction("linux", "AXPress")).toThrow(/does not perform/);
    expect(() => assertSemanticAction("macos", "AXScrollToVisible")).not.toThrow();
  });
});
