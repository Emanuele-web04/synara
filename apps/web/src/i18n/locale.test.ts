import { describe, expect, it, vi } from "vitest";

import { APP_SETTINGS_STORAGE_KEY } from "../appSettingsStorage";
import { readLanguagePreference } from "./locale";

describe("persisted interface locale", () => {
  it("reads Chinese from the existing app-settings record", () => {
    const getItem = vi.fn(() => '{"language":"zh-CN","theme":"dark"}');
    expect(readLanguagePreference({ getItem })).toBe("zh-CN");
    expect(getItem).toHaveBeenCalledWith(APP_SETTINGS_STORAGE_KEY);
  });

  it("uses System for malformed, unsupported, or unavailable stored preferences", () => {
    for (const raw of [
      null,
      "invalid JSON",
      '"zh-CN"',
      "[]",
      '{"language":"zh-Hant"}',
      '{"language":"fr"}',
    ]) {
      expect(readLanguagePreference({ getItem: () => raw })).toBe("system");
    }
    expect(
      readLanguagePreference({
        getItem: () => {
          throw new Error("blocked storage");
        },
      }),
    ).toBe("system");
  });
});
