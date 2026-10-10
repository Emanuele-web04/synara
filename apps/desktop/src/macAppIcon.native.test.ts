import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { spawnProcessSync } from "@synara/shared/processRuntime";
import { describe, expect, it } from "vitest";

import { persistMacAppIcon } from "./macAppIcon";

describe.skipIf(process.platform !== "darwin")("native macOS custom icon persistence", () => {
  it("keeps a custom icon after the writer exits and removes it for Default", async () => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "synara-native-icon-"));
    const bundlePath = Path.join(root, "Synara's Icon Probe.app");
    const cacheDirectory = Path.join(root, "cache");
    try {
      await FS.mkdir(bundlePath);
      const png = await FS.readFile(
        Path.join(import.meta.dirname, "../resources/dock-icon-dark.png"),
      );
      await persistMacAppIcon({ bundlePath, cacheDirectory, png });

      // Read Finder's on-disk custom-icon bit in a separate process, after the
      // native writer has exited. A runtime Dock override cannot set this bit.
      const customInfo = spawnProcessSync(
        "/usr/bin/xattr",
        ["-px", "com.apple.FinderInfo", bundlePath],
        { encoding: "utf8" },
      );
      expect(customInfo.status).toBe(0);
      const bytes = Buffer.from(customInfo.stdout.replaceAll(/\s/gu, ""), "hex");
      expect(bytes.readUInt16BE(8) & 0x0400).toBe(0x0400);

      await persistMacAppIcon({ bundlePath, cacheDirectory, png: null });
      const defaultInfo = spawnProcessSync(
        "/usr/bin/xattr",
        ["-px", "com.apple.FinderInfo", bundlePath],
        { encoding: "utf8" },
      );
      // AppKit may remove FinderInfo entirely when no other flags remain.
      if (defaultInfo.status === 0) {
        const restored = Buffer.from(defaultInfo.stdout.replaceAll(/\s/gu, ""), "hex");
        expect(restored.readUInt16BE(8) & 0x0400).toBe(0);
      } else {
        expect(defaultInfo.stderr).toContain("No such xattr");
      }
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  });
});
