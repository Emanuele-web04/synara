// FILE: desktopServerSettings.test.ts
// Purpose: Verifies desktop startup reads server settings safely before backend boot.
// Layer: Desktop startup tests

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import {
  readDesktopEnableWandySetting,
  resolveDesktopServerSettingsPath,
} from "./desktopServerSettings";

function makeTempRoot(name: string): string {
  const root = path.join(tmpdir(), `synara-${name}-${process.pid}-${Date.now()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

describe("desktop server settings", () => {
  it("uses the shared default when settings are missing or invalid", () => {
    const root = makeTempRoot("desktop-settings-default");
    const settingsPath = path.join(root, "settings.json");

    try {
      assert.equal(readDesktopEnableWandySetting(settingsPath), true);
      writeFileSync(settingsPath, "{not-json", "utf8");
      assert.equal(readDesktopEnableWandySetting(settingsPath), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors the persisted Wandy toggle before backend startup", () => {
    const root = makeTempRoot("desktop-settings-wandy");
    const settingsPath = path.join(root, "settings.json");

    try {
      writeFileSync(settingsPath, `${JSON.stringify({ enableWandy: false })}\n`, "utf8");
      assert.equal(readDesktopEnableWandySetting(settingsPath), false);

      writeFileSync(settingsPath, `${JSON.stringify({ enableWandy: true })}\n`, "utf8");
      assert.equal(readDesktopEnableWandySetting(settingsPath), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives the same settings path as the desktop backend environment", () => {
    assert.equal(
      resolveDesktopServerSettingsPath("/tmp/synara"),
      path.join("/tmp/synara", "userdata", "settings.json"),
    );
  });
});
