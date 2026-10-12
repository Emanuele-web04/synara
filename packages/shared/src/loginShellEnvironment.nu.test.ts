import * as Assert from "node:assert/strict";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, it } from "vitest";

import { createCachedLoginShellPathReader } from "./loginShellEnvironment";

const platforms = [
  { platform: "darwin", segments: ["Library", "Application Support", "nushell"] },
  { platform: "linux", segments: [".config", "nushell"] },
  { platform: "win32", segments: ["AppData", "Roaming", "nushell"] },
] as const;

describe("Nushell login environment cache", () => {
  for (const { platform, segments } of platforms) {
    for (const name of ["env.nu", "config.nu", "login.nu"]) {
      it(`refreshes after creating, editing, or removing ${platform} ${name}`, () => {
        const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-nu-cache-"));
        try {
          const shell = Path.join(root, platform === "win32" ? "nu.exe" : "nu");
          FS.writeFileSync(shell, "shell fingerprint");
          const configPath = Path.join(root, ...segments, name);
          let probes = 0;
          const options = {
            env: {},
            platform,
            homeDirectory: root,
            cachePath: Path.join(root, "cache.json"),
            now: () => 1_000,
            probe: () => ({ PATH: `path-${++probes}` }),
          };
          // Recreate the reader to exercise disk reuse across application launches.
          const read = () => createCachedLoginShellPathReader(options)(shell);
          Assert.equal(read(), "path-1");
          Assert.equal(read(), "path-1");

          FS.mkdirSync(Path.dirname(configPath), { recursive: true });
          FS.writeFileSync(configPath, "# Enable mise\n");
          Assert.equal(read(), "path-2");
          Assert.equal(read(), "path-2");

          // Change size as well as contents, without relying on mtime resolution.
          FS.writeFileSync(configPath, "# Enable mise and another toolchain\n");
          Assert.equal(read(), "path-3");
          Assert.equal(read(), "path-3");

          FS.unlinkSync(configPath);
          Assert.equal(read(), "path-4");
          Assert.equal(read(), "path-4");
          Assert.equal(probes, 4);
        } finally {
          FS.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }

  it("does not invalidate another shell when Nushell configuration changes", () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-nu-cache-"));
    try {
      const shell = Path.join(root, "bash");
      FS.writeFileSync(shell, "shell fingerprint");
      let probes = 0;
      const read = createCachedLoginShellPathReader({
        env: {},
        platform: "linux",
        homeDirectory: root,
        cachePath: Path.join(root, "cache.json"),
        now: () => 1_000,
        probe: () => ({ PATH: `path-${++probes}` }),
      });
      Assert.equal(read(shell), "path-1");
      const configPath = Path.join(root, ".config", "nushell", "config.nu");
      FS.mkdirSync(Path.dirname(configPath), { recursive: true });
      FS.writeFileSync(configPath, "# Enable mise\n");
      Assert.equal(read(shell), "path-1");
      Assert.equal(probes, 1);
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });
});
