import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { ensureDebugAdapter } from "./debugAdapterInstaller";

afterEach(() => {
  vi.unstubAllGlobals();
});

// No network: the download is stubbed to fail, which is enough to prove a corrupt
// install is removed and retried once instead of blocking the debugger.
it("replaces a corrupt install with one shared download instead of failing on it", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "synara-js-debug-install-"));
  try {
    const download = vi.fn(
      async (_url: string | URL | Request) => new Response(null, { status: 503 }),
    );
    vi.stubGlobal("fetch", download);
    await expect(ensureDebugAdapter(state)).rejects.toThrow("(503)");
    const version = /\/download\/v([^/]+)\//u.exec(String(download.mock.calls[0]?.[0]))?.[1];
    const installed = path.join(state, "editor-runtimes", `js-debug-${version}`);
    await mkdir(path.join(installed, "js-debug"), { recursive: true });
    await writeFile(path.join(installed, "integrity.json"), '{"archive":"stale","entry":"stale"}');

    const attempts = await Promise.allSettled([
      ensureDebugAdapter(state),
      ensureDebugAdapter(state),
    ]);

    expect(
      attempts.map((attempt) => attempt.status === "rejected" && String(attempt.reason)),
    ).toEqual([expect.stringContaining("(503)"), expect.stringContaining("(503)")]);
    expect(download).toHaveBeenCalledTimes(2);
    expect(await readdir(path.join(state, "editor-runtimes"))).toEqual([]);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
