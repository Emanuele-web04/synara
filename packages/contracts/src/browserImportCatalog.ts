import { Schema } from "effect";

export const BROWSER_IMPORT_CATALOG_IDS = [
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
] as const;
export const BrowserImportCatalogId = Schema.Literals(BROWSER_IMPORT_CATALOG_IDS);
export type BrowserImportCatalogId = typeof BrowserImportCatalogId.Type;

export type BrowserDesktopPlatform = "macos" | "windows" | "linux";

/**
 * Candidate browsers and their published desktop platforms. This is not an
 * installation or import-support list: discovery must confirm an installed
 * browser before it is offered, and BrowserCookieSource remains the runtime gate.
 */
export const BROWSER_IMPORT_CATALOG = [
  { id: "chrome", name: "Google Chrome", desktopPlatforms: ["macos", "windows", "linux"] },
  { id: "edge", name: "Microsoft Edge", desktopPlatforms: ["macos", "windows", "linux"] },
  { id: "brave", name: "Brave", desktopPlatforms: ["macos", "windows", "linux"] },
  { id: "arc", name: "Arc", desktopPlatforms: ["macos", "windows"] },
  { id: "dia", name: "Dia", desktopPlatforms: ["macos", "windows"] },
  { id: "vivaldi", name: "Vivaldi", desktopPlatforms: ["macos", "windows", "linux"] },
  { id: "opera", name: "Opera", desktopPlatforms: ["macos", "windows", "linux"] },
  { id: "opera-gx", name: "Opera GX", desktopPlatforms: ["macos", "windows", "linux"] },
  { id: "chromium", name: "Chromium", desktopPlatforms: ["macos", "windows", "linux"] },
  { id: "helium", name: "Helium", desktopPlatforms: ["macos", "windows", "linux"] },
  { id: "comet", name: "Comet", desktopPlatforms: ["macos", "windows"] },
  { id: "aside", name: "Aside", desktopPlatforms: ["macos", "windows"] },
  { id: "firefox", name: "Firefox", desktopPlatforms: ["macos", "windows", "linux"] },
  { id: "zen", name: "Zen Browser", desktopPlatforms: ["macos", "windows", "linux"] },
  { id: "safari", name: "Safari", desktopPlatforms: ["macos"] },
] as const satisfies ReadonlyArray<{
  id: BrowserImportCatalogId;
  name: string;
  desktopPlatforms: ReadonlyArray<BrowserDesktopPlatform>;
}>;
