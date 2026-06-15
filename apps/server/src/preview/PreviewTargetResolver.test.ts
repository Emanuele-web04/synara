import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePreviewTarget } from "./PreviewTargetResolver";

let tmpDir: string;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

describe("resolvePreviewTarget", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-preview-target-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("selects a Vite workspace app over a monorepo root script", async () => {
    await writeJson(path.join(tmpDir, "package.json"), {
      workspaces: ["apps/*"],
      scripts: { dev: "turbo dev" },
      packageManager: "pnpm@10.0.0",
    });
    await writeJson(path.join(tmpDir, "apps/web/package.json"), {
      scripts: { dev: "vite" },
      dependencies: { vite: "^8.0.0" },
    });
    await fs.writeFile(path.join(tmpDir, "apps/web/vite.config.ts"), "export default {}");

    const target = await resolvePreviewTarget({ cwd: tmpDir, port: 6123 });

    expect(target.runCwd).toBe(path.join(tmpDir, "apps/web"));
    expect(target.framework).toBe("vite");
    expect(target.command).toBe("pnpm run dev -- --host 127.0.0.1 --port 6123");
  });

  it("uses Next.js port flags for Next apps", async () => {
    await writeJson(path.join(tmpDir, "package.json"), {
      scripts: { dev: "next dev" },
      dependencies: { next: "^16.0.0" },
    });
    await fs.writeFile(path.join(tmpDir, "next.config.js"), "module.exports = {}");

    const target = await resolvePreviewTarget({ cwd: tmpDir, port: 6124 });

    expect(target.framework).toBe("next");
    expect(target.command).toBe("npm run dev -- -H 127.0.0.1 -p 6124");
  });

  it("uses explicit URLs without creating a managed command", async () => {
    const target = await resolvePreviewTarget({
      cwd: tmpDir,
      port: 6125,
      url: "http://localhost:3000",
    });

    expect(target.resolverKind).toBe("url");
    expect(target.url).toBe("http://localhost:3000");
    expect(target.command).toBeNull();
  });

  it("uses explicit URLs even when the local cwd is unavailable", async () => {
    const missingDir = path.join(tmpDir, "missing");

    const target = await resolvePreviewTarget({
      cwd: missingDir,
      port: 6125,
      url: "http://localhost:3000",
    });

    expect(target.runCwd).toBe(missingDir);
    expect(target.command).toBeNull();
  });

  it("reports a missing project cwd clearly", async () => {
    const missingDir = path.join(tmpDir, "missing");

    await expect(resolvePreviewTarget({ cwd: missingDir, port: 6127 })).rejects.toThrow(
      `Live Edit project path does not exist: ${missingDir}`,
    );
  });

  it("reports a missing target path clearly", async () => {
    await expect(
      resolvePreviewTarget({ cwd: tmpDir, port: 6128, target: "apps/missing" }),
    ).rejects.toThrow(`Live Edit target path does not exist: ${path.join(tmpDir, "apps/missing")}`);
  });

  it("falls back to a static index.html server", async () => {
    await fs.writeFile(path.join(tmpDir, "index.html"), "<main>Hello</main>");

    const target = await resolvePreviewTarget({ cwd: tmpDir, port: 6126 });

    expect(target.resolverKind).toBe("static");
    expect(target.framework).toBe("static");
    expect(target.command).toBe("python3 -m http.server 6126 --bind 127.0.0.1");
  });
});
