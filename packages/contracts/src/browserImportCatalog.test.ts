import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  BROWSER_IMPORT_CATALOG,
  BROWSER_IMPORT_CATALOG_IDS,
  BrowserCookieSource,
  BrowserImportCatalogId,
  type BrowserDesktopPlatform,
} from "./index";

describe("browser import candidate catalog", () => {
  const currentRuntimeSources = [
    "chrome",
    "safari",
    "edge",
    "brave",
    "chromium",
    "opera",
    "vivaldi",
    "helium",
    "aside",
    "arc",
    "dia",
  ];
  const expectedDesktopPlatforms: Record<
    (typeof BROWSER_IMPORT_CATALOG_IDS)[number],
    ReadonlyArray<BrowserDesktopPlatform>
  > = {
    chrome: ["macos", "windows", "linux"],
    edge: ["macos", "windows", "linux"],
    brave: ["macos", "windows", "linux"],
    arc: ["macos", "windows"],
    dia: ["macos", "windows"],
    vivaldi: ["macos", "windows", "linux"],
    opera: ["macos", "windows", "linux"],
    "opera-gx": ["macos", "windows", "linux"],
    chromium: ["macos", "windows", "linux"],
    helium: ["macos", "windows", "linux"],
    comet: ["macos", "windows"],
    aside: ["macos", "windows"],
    firefox: ["macos", "windows", "linux"],
    zen: ["macos", "windows", "linux"],
    safari: ["macos"],
  };

  it("lists exactly the requested browser identities", () => {
    const expected = [
      "chrome",
      "edge",
      "brave",
      "arc",
      "dia",
      "vivaldi",
      "opera",
      "opera-gx",
      "chromium",
      "helium",
      "comet",
      "aside",
      "firefox",
      "zen",
      "safari",
    ];

    expect(BROWSER_IMPORT_CATALOG_IDS).toEqual(expected);
    expect(BROWSER_IMPORT_CATALOG.map(({ id }) => id)).toEqual(BROWSER_IMPORT_CATALOG_IDS);
    expect(new Set(BROWSER_IMPORT_CATALOG.map(({ id }) => id)).size).toBe(expected.length);
    for (const id of expected) expect(Schema.is(BrowserImportCatalogId)(id)).toBe(true);
    for (const id of ["unknown", "__proto__", "constructor", "toString"]) {
      expect(Schema.is(BrowserImportCatalogId)(id)).toBe(false);
    }
  });

  it("keeps candidate metadata separate from the installed-source runtime gate", () => {
    for (const { id, name, desktopPlatforms } of BROWSER_IMPORT_CATALOG) {
      expect(name.trim()).not.toBe("");
      expect(desktopPlatforms.length).toBeGreaterThan(0);
      expect(new Set(desktopPlatforms).size).toBe(desktopPlatforms.length);
      expect(desktopPlatforms).toEqual(expectedDesktopPlatforms[id]);
      expect(Schema.is(BrowserCookieSource)(id)).toBe(currentRuntimeSources.includes(id));
    }

    for (const id of currentRuntimeSources) {
      expect(Schema.is(BrowserCookieSource)(id)).toBe(true);
    }
  });
});
