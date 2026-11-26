import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { hashFile } from "./file-digest.ts";
import {
  hybridArchiveMetadata,
  hybridLicense,
  verifyMacHybridElectron,
} from "./mac-hybrid-electron.ts";

it.skipIf(process.platform !== "darwin")(
  "rejects substituted archives and frameworks without the hybrid API",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "synara-hybrid-zip-"));
    const info = hybridArchiveMetadata("arm64");
    const archive = join(dir, info.archive);
    try {
      const framework = join(
        dir,
        "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      );
      await mkdir(dirname(framework), { recursive: true });
      const header = Buffer.alloc(32);
      header.writeUInt32LE(0xfeedfacf);
      header.writeUInt32LE(0x0100000c, 4);
      await writeFile(framework, header);
      await writeFile(
        join(dir, "Electron.app/Contents/Info.plist"),
        `<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${info.electronVersion}</string></dict></plist>`,
      );
      await copyFile(hybridLicense, join(dir, "LICENSE-Nightly-Labs"));
      execFileSync("/usr/bin/zip", ["-qr", archive, "Electron.app", "LICENSE-Nightly-Labs"], {
        cwd: dir,
      });
      const manifest = join(dir, "manifest.json");
      await writeFile(manifest, JSON.stringify({ ...info, archiveSha256: "0".repeat(64) }));
      await expect(verifyMacHybridElectron(dir, "arm64", info.electronVersion)).rejects.toThrow(
        "archive digest",
      );
      await writeFile(
        manifest,
        JSON.stringify({ ...info, archiveSha256: await hashFile(archive) }),
      );
      await expect(verifyMacHybridElectron(dir, "x64", info.electronVersion)).rejects.toThrow(
        "manifest field",
      );
      await expect(verifyMacHybridElectron(dir, "arm64", info.electronVersion)).rejects.toThrow(
        "lacks the native hybrid session API",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
