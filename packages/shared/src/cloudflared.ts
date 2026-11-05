import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnProcessSync } from "./processRuntime.ts";

export const CLOUDFLARED_VERSION = "2026.10.3";
/** Official GitHub asset digests (the downloaded TGZ on macOS), verified 2026-10-26. */
export const CLOUDFLARED_ASSETS: Readonly<Record<string, { name: string; sha256: string }>> = {
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55",
  },
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000",
  },
  "linux-arm64": {
    name: "cloudflared-linux-arm64",
    sha256: "89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8",
  },
  "linux-x64": {
    name: "cloudflared-linux-amd64",
    sha256: "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0",
  },
  "win32-x64": {
    name: "cloudflared-windows-amd64.exe",
    sha256: "76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2",
  },
};

/** Build/CLI installation, never an administrative Cloudflare API call. */
export async function installCloudflared(
  directory: string,
  platform = process.platform,
  arch = process.arch,
  signal?: AbortSignal,
): Promise<string> {
  const asset = CLOUDFLARED_ASSETS[`${platform}-${arch}`];
  if (!asset) throw new Error("Cloudflare remote is unsupported on this platform");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cache = join(directory, asset.name);
  let bytes = await readFile(cache).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (!bytes) {
    const response = await fetch(
      `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`,
      {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok) throw new Error("Could not download the pinned Cloudflare connector");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Cloudflare connector download was empty");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 128 * 1024 * 1024)
          throw new Error("Cloudflare connector download exceeded its size limit");
        chunks.push(part.value);
      }
      bytes = Buffer.concat(chunks);
    } finally {
      await reader.cancel();
    }
  }
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error("Cloudflare connector integrity check failed");
  signal?.throwIfAborted();
  const binaryName = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const binary = join(directory, binaryName);
  const temporary = await mkdtemp(join(directory, ".install-"));
  try {
    if (asset.name.endsWith(".tgz")) {
      const archive = join(temporary, "release.tgz");
      await writeFile(archive, bytes, { mode: 0o600 });
      const unpack = spawnProcessSync("tar", ["-xzf", archive, "-C", temporary, "cloudflared"], {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (unpack.error || unpack.status !== 0)
        throw new Error("Could not unpack the verified Cloudflare connector");
    } else await writeFile(join(temporary, binaryName), bytes);
    await chmod(join(temporary, binaryName), 0o755);
    await rename(join(temporary, binaryName), binary);
    const cacheTemp = join(directory, `.asset-${randomUUID()}`);
    await writeFile(cacheTemp, bytes, { mode: 0o600 });
    await rename(cacheTemp, cache);
    return binary;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
