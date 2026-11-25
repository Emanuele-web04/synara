import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UI_LOCALES } from "@synara/contracts";

import {
  applyDesktopLanguagePreference,
  isDesktopLanguagePreference,
  readDesktopLanguagePreference,
  writeDesktopLanguagePreference,
} from "./desktopPreferences";

const temporaryDirectories: string[] = [];
afterEach(() =>
  temporaryDirectories
    .splice(0)
    .forEach((path) => FS.rmSync(path, { recursive: true, force: true })),
);

describe("native language preference", () => {
  it("rejects untrusted IPC senders and malformed payloads before writing or changing the runtime", () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-language-ipc-"));
    temporaryDirectories.push(dir);
    const path = Path.join(dir, "desktop-language.json");
    const applied: string[] = [];
    const input = {
      preferencePath: path,
      isTrustedSender: true,
      onPreference: (value: string) => applied.push(value),
    };
    expect(applyDesktopLanguagePreference("es", { ...input, isTrustedSender: false })).toBe(false);
    expect(applyDesktopLanguagePreference({ language: "es" }, input)).toBe(false);
    expect(FS.existsSync(path)).toBe(false);
    expect(applied).toEqual([]);
    expect(applyDesktopLanguagePreference("es", input)).toBe(true);
    expect(readDesktopLanguagePreference(path)).toBe("es");
    expect(applied).toEqual(["es"]);
  });

  it("accepts every shipped IPC language and rejects aliases or malformed values", () => {
    for (const value of ["system", ...UI_LOCALES])
      expect(isDesktopLanguagePreference(value)).toBe(true);
    for (const value of [null, "es-MX", "hi", 42, {}, ["es"]])
      expect(isDesktopLanguagePreference(value)).toBe(false);
  });

  it("round-trips preference files and defaults missing or corrupt settings", () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-language-"));
    temporaryDirectories.push(dir);
    const path = Path.join(dir, "userdata", "desktop-language.json");
    expect(readDesktopLanguagePreference(path)).toBe("system");
    writeDesktopLanguagePreference(path, "zh-CN");
    expect(readDesktopLanguagePreference(path)).toBe("zh-CN");
    expect(FS.readdirSync(Path.dirname(path))).toEqual(["desktop-language.json"]);
    FS.writeFileSync(path, '{"version":1,"language":"hi"}');
    expect(readDesktopLanguagePreference(path)).toBe("system");
    FS.writeFileSync(path, "broken");
    expect(readDesktopLanguagePreference(path)).toBe("system");
  });
});
