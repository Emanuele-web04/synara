import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cuaHostProcessIsAlive,
  markCuaRuntimeDirectory,
  sweepOwnedCuaRuntimeDirectories,
} from "./cuaRuntimeOwnership";

const roots: string[] = [];
const old = Date.now() - 120_000;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "synara-runtime-ownership-test-"));
  roots.push(directory);
  return directory;
}
async function owned(root: string, name = "synara-cua-Ab123Z") {
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  await markCuaRuntimeDirectory(directory);
  const markerPath = join(directory, ".synara-cua-runtime.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  await writeFile(markerPath, JSON.stringify({ ...marker, createdAt: old }));
  await writeFile(join(directory, "state"), "owned temporary state");
  await utimes(directory, old / 1000, old / 1000);
  return { directory, markerPath, marker };
}
function sweep(directory: string, liveSocketDirs: ReadonlySet<string> = new Set()) {
  return sweepOwnedCuaRuntimeDirectories({
    directory,
    liveSocketDirs,
    isProcessAlive: () => false,
  });
}

describe.skipIf(process.platform === "win32")("owned Cua runtime cleanup", () => {
  it("never removes similarly named tools/evidence or an unmarked legacy runtime", async () => {
    const root = await fixture();
    const names = ["synara-cua-tools", "synara-cua-native-work", "synara-cua-Ab123Z"];
    for (const name of names) {
      const path = join(root, name);
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, "important"), "preserve");
      await utimes(path, old / 1000, old / 1000);
    }
    expect(sweep(root)).toEqual([]);
    for (const name of names)
      expect(await readFile(join(root, name, "important"), "utf8")).toBe("preserve");
  });

  it("protects a live lazy host even when it has never spawned a driver", async () => {
    const root = await fixture();
    const runtime = await owned(root);
    expect(sweepOwnedCuaRuntimeDirectories({ directory: root, liveSocketDirs: new Set() })).toEqual(
      [],
    );
    expect(existsSync(runtime.directory)).toBe(true);
  });

  it("removes only a marked private stale directory whose owner is confirmed dead", async () => {
    const root = await fixture();
    const runtime = await owned(root);
    expect(sweep(root)).toEqual(["synara-cua-Ab123Z"]);
    expect(existsSync(runtime.directory)).toBe(false);
  });

  it("keeps the directory of a still-running driver even after its host died", async () => {
    const root = await fixture();
    const runtime = await owned(root);
    expect(sweep(root, new Set([runtime.directory]))).toEqual([]);
    expect(existsSync(runtime.directory)).toBe(true);
  });

  it("never follows a runtime directory or ownership-marker symlink", async () => {
    const root = await fixture();
    const external = join(root, "preserved-evidence");
    await mkdir(external, { mode: 0o700 });
    await writeFile(join(external, "important"), "preserve");
    await symlink(external, join(root, "synara-cua-link99"));
    const runtime = await owned(root);
    const marker = await readFile(runtime.markerPath, "utf8");
    const externalMarker = join(external, "marker.json");
    await writeFile(externalMarker, marker, { mode: 0o600 });
    await unlink(runtime.markerPath);
    await symlink(externalMarker, runtime.markerPath);
    await utimes(runtime.directory, old / 1000, old / 1000);
    expect(sweep(root)).toEqual([]);
    expect(await readFile(join(external, "important"), "utf8")).toBe("preserve");
    expect(existsSync(runtime.directory)).toBe(true);
  });

  it.each([
    { ownerUid: (process.getuid?.() ?? 0) + 1 },
    { directory: "synara-cua-Other1" },
    { schema: "some-other-application" },
    { hostPid: 0 },
    { hostPid: "123" },
    { createdAt: Date.now() },
  ])("preserves malformed, foreign, or newly created ownership %j", async (override) => {
    const root = await fixture();
    const runtime = await owned(root);
    await writeFile(
      runtime.markerPath,
      JSON.stringify({ ...runtime.marker, createdAt: old, ...override }),
    );
    expect(sweep(root)).toEqual([]);
    expect(existsSync(runtime.directory)).toBe(true);
  });

  it("preserves a FIFO marker without waiting for a writer", async () => {
    const root = await fixture();
    const runtime = await owned(root);
    await unlink(runtime.markerPath);
    execFileSync("mkfifo", [runtime.markerPath]);
    await utimes(runtime.directory, old / 1000, old / 1000);
    expect(sweep(root)).toEqual([]);
    expect(existsSync(runtime.directory)).toBe(true);
  });

  it("does not accept a marker writable by another user", async () => {
    const root = await fixture();
    const runtime = await owned(root);
    await chmod(runtime.markerPath, 0o666);
    expect(sweep(root)).toEqual([]);
    expect(existsSync(runtime.directory)).toBe(true);
  });

  it("treats inaccessible process ownership as alive rather than permission to delete", () => {
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    expect(cuaHostProcessIsAlive(123)).toBe(true);
    kill.mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(cuaHostProcessIsAlive(123)).toBe(false);
  });
});
