import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installCloudflared } from "@synara/shared/cloudflared";
import { spawnProcessSync } from "@synara/shared/processRuntime";

/** Stage only the verified executable; downloaded archives never enter the app. */
export async function stageCloudflared(
  destination: string,
  platform: "mac" | "linux" | "win",
  arch: "arm64" | "x64" | "universal",
) {
  const temporary = await mkdtemp(join(tmpdir(), "synara-cloudflared-build-"));
  await mkdir(destination, { recursive: true });
  const targetPlatform = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  const binary = join(destination, platform === "win" ? "cloudflared.exe" : "cloudflared");
  try {
    if (arch === "universal") {
      if (platform !== "mac") throw new Error("Universal Cloudflare connector requires macOS");
      const arm = await installCloudflared(join(temporary, "arm64"), "darwin", "arm64");
      const intel = await installCloudflared(join(temporary, "x64"), "darwin", "x64");
      const result = spawnProcessSync("lipo", ["-create", arm, intel, "-output", binary], {
        timeout: 30_000,
      });
      if (result.error || result.status !== 0)
        throw new Error("Could not assemble the verified universal connector");
    } else {
      // Cloudflare publishes only x86 Windows executables; ARM Windows requires OS emulation.
      const assetArch = platform === "win" ? "x64" : arch;
      await copyFile(await installCloudflared(temporary, targetPlatform, assetArch), binary);
    }
    return binary;
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}
