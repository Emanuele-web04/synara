import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readHyprlandPrebuiltManifest } from "../hyprlandPluginProvisioning.ts";
import { readPrebuiltManifest } from "../kwinPluginProvisioning.ts";

describe.each([
  {
    backend: "KWin",
    readManifest: readPrebuiltManifest,
    version: { kwinVersion: "6.7.3", builtOn: "fedora-43" },
  },
  {
    backend: "Hyprland",
    readManifest: readHyprlandPrebuiltManifest,
    version: { hyprlandVersion: "0.56.2" },
  },
])("$backend prebuilt manifest validation", ({ readManifest, version }) => {
  it("drops malformed and escaping entries while retaining usable builds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "synara-prebuilt-validation-"));
    try {
      const path = join(directory, "manifest.json");
      const valid = { ...version, arch: "x64", file: "plugin.so", sha256: "a".repeat(64) };
      const invalid = [
        null,
        false,
        [],
        {},
        { ...valid, arch: "" },
        { ...valid, arch: 42 },
        { ...valid, sha256: "" },
        { ...valid, sha256: "00" },
        { ...valid, sha256: "z".repeat(64) },
        { ...valid, sha256: 42 },
        ...[
          "../outside.so",
          "/outside.so",
          "dir/plugin.so",
          "dir\\plugin.so",
          ".",
          "..",
          "",
          "\0.so",
        ].map((file) => ({ ...valid, file })),
      ];

      await writeFile(path, JSON.stringify({ builds: [...invalid, valid] }));
      expect(await readManifest(path)).toEqual({ builds: [valid] });

      await writeFile(path, JSON.stringify({ builds: invalid }));
      expect(await readManifest(path)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
