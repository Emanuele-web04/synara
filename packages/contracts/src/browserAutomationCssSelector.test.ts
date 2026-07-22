import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { BrowserCssSelector } from "./browserAutomationCssSelector";

describe("BrowserCssSelector", () => {
  it.each([
    "#save",
    "main > form[data-kind='account'] button.primary",
    "article:has(> h2) a[href^='https://']",
    ":host([data-theme='dark']) .item:nth-child(2)",
  ])("accepts bounded native CSS: %s", (selector) => {
    expect(Schema.is(BrowserCssSelector)(selector)).toBe(true);
  });

  it.each([
    "",
    "text=Save",
    "css=#save",
    "xpath=//button",
    "div >> button",
    "button:has-text('Save')",
    "button:text('Save')",
    "button:right-of(label)",
    "button:nth-match(2)",
    "/save/i",
    "div/*comment*/span",
    "div:unknown(foo)",
    "div\\",
    "div\u0000span",
  ])("rejects non-native or unsafe selector syntax: %s", (selector) => {
    expect(Schema.is(BrowserCssSelector)(selector)).toBe(false);
  });

  it("enforces UTF-8, token and nesting bounds", () => {
    expect(Schema.is(BrowserCssSelector)("a".repeat(4_097))).toBe(false);
    expect(Schema.is(BrowserCssSelector)("\u{1f600}".repeat(1_025))).toBe(false);
    expect(Schema.is(BrowserCssSelector)(":has(".repeat(17) + "a" + ")".repeat(17))).toBe(false);
    expect(Schema.is(BrowserCssSelector)(Array.from({ length: 513 }, () => "a").join(" > "))).toBe(
      false,
    );
  });
});
