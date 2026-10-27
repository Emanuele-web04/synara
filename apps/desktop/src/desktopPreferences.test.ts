import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("accepts only supported IPC values", () => {
    for (const value of ["system", "en", "zh-CN", "es"])
      expect(isDesktopLanguagePreference(value)).toBe(true);
    for (const value of [null, "es-MX", "fr", 42, {}, ["es"]])
      expect(isDesktopLanguagePreference(value)).toBe(false);
  });

  it("round-trips each preference file and defaults missing or corrupt settings", () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-language-"));
    temporaryDirectories.push(dir);
    const stable = Path.join(dir, "stable", "userdata", "desktop-language.json");
    const beta = Path.join(dir, "beta", "userdata", "desktop-language.json");
    expect(readDesktopLanguagePreference(stable)).toBe("system");
    writeDesktopLanguagePreference(stable, "zh-CN");
    expect(readDesktopLanguagePreference(stable)).toBe("zh-CN");
    expect(readDesktopLanguagePreference(beta)).toBe("system");
    expect(FS.readdirSync(Path.dirname(stable))).toEqual(["desktop-language.json"]);
    FS.writeFileSync(stable, '{"version":1,"language":"fr"}');
    expect(readDesktopLanguagePreference(stable)).toBe("system");
    FS.writeFileSync(stable, "broken");
    expect(readDesktopLanguagePreference(stable)).toBe("system");
  });
});
