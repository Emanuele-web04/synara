// FILE: desktopQuitPreference.test.ts
// Purpose: Guards the idle-quit preference store: versioned round-trip and the
//          safe ask-first fallback for missing or malformed state.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseDesktopQuitPreference,
  readAskOnIdleQuit,
  writeAskOnIdleQuit,
} from "./desktopQuitPreference";

const temporaryDirectories: string[] = [];

function preferencePath(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-quit-preference-"));
  temporaryDirectories.push(directory);
  return Path.join(directory, "desktop-quit-preference.json");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseDesktopQuitPreference", () => {
  it("accepts only a versioned boolean preference", () => {
    expect(parseDesktopQuitPreference({ version: 1, askOnIdleQuit: false })).toEqual({
      version: 1,
      askOnIdleQuit: false,
    });
    expect(parseDesktopQuitPreference({ version: 2, askOnIdleQuit: false })).toBeNull();
    expect(parseDesktopQuitPreference({ version: 1, askOnIdleQuit: "no" })).toBeNull();
    expect(parseDesktopQuitPreference(null)).toBeNull();
    expect(parseDesktopQuitPreference([])).toBeNull();
  });
});

describe("readAskOnIdleQuit", () => {
  it("asks when the file is missing", () => {
    expect(readAskOnIdleQuit(preferencePath())).toBe(true);
  });

  it("round-trips both choices", () => {
    const file = preferencePath();

    writeAskOnIdleQuit(file, false);
    expect(readAskOnIdleQuit(file)).toBe(false);

    writeAskOnIdleQuit(file, true);
    expect(readAskOnIdleQuit(file)).toBe(true);
  });

  it("asks when the file is unreadable or malformed", () => {
    const file = preferencePath();
    FS.writeFileSync(file, "{not json", "utf8");

    expect(readAskOnIdleQuit(file)).toBe(true);
  });

  it("reports a save it could not write", () => {
    const file = preferencePath();
    FS.writeFileSync(file, "not a directory", "utf8");

    expect(writeAskOnIdleQuit(Path.join(file, "nested"), false)).toBe(false);
  });
});
