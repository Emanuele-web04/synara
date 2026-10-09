import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnProcessSync } from "./processRuntime.ts";

export const CLOUDFLARED_VERSION = "2026.9.3";
/** Official GitHub release asset digests, verified 2026-09-28. */
export const CLOUDFLARED_ASSETS: Readonly<Record<string, { name: string; sha256: string }>> = {
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095",
  },
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "d1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977",
  },
  "linux-arm64": {
    name: "cloudflared-linux-arm64",
    sha256: "aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d",
  },
  "linux-x64": {
    name: "cloudflared-linux-amd64",
    sha256: "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2",
  },
  "win32-x64": {
    name: "cloudflared-windows-amd64.exe",
    sha256: "f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2",
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
