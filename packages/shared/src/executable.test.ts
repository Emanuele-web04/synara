import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBatchExecutableResolver,
  executableCandidates,
  resolveExecutable,
} from "./executable";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "synara-executable-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createBatchExecutableResolver", () => {
  it.each(["absolute", "relative", "normalized", "case-folded", "default cwd"])(
    "filters the launch cwd from Windows PATH candidates (%s)",
    (kind) => {
      const cwd = makeTempDir();
      const bin = makeTempDir();
      const local = join(cwd, "tool.CMD");
      const expected = join(bin, "tool.CMD");
      writeFileSync(local, "@echo off\r\n");
      writeFileSync(expected, "@echo off\r\n");
      const entry =
        kind === "relative"
          ? "."
          : kind === "normalized"
            ? `${cwd}/.`
            : kind === "case-folded"
              ? `${cwd.toUpperCase()}/`
              : cwd;
      if (kind === "default cwd") vi.spyOn(process, "cwd").mockReturnValue(cwd);
      const options = {
        platform: "win32" as const,
        ...(kind === "default cwd" ? {} : { cwd }),
        env: { PATH: `${entry};${bin}`, PATHEXT: ".CMD" },
      };
      expect(
        [...executableCandidates("tool", options)].every(
          (candidate) => candidate.directory === bin,
        ),
      ).toBe(true);
      expect(resolveExecutable("tool", options)).toBe(expected);
      expect(createBatchExecutableResolver(options)("tool")).toBe(expected);
    },
  );

  it("preserves an explicitly qualified Windows command in the launch cwd", () => {
    const cwd = makeTempDir();
    const command = join(cwd, "tool");
    writeFileSync(`${command}.CMD`, "@echo off\r\n");
    const options = { platform: "win32" as const, cwd, env: { PATH: cwd, PATHEXT: ".CMD" } };
    expect(resolveExecutable(command, options)).toBe(`${command}.CMD`);
    expect(createBatchExecutableResolver(options)(command)).toBe(`${command}.CMD`);
  });

  it("retains explicit cwd entries in POSIX PATH lookup", () => {
    expect([
      ...executableCandidates("tool", {
        platform: "linux",
        cwd: "/working",
        env: { PATH: "/working" },
      }),
    ]).toEqual([{ directory: "/working", path: join("/working", "tool") }]);
  });

  it("matches resolveExecutable across PATH order, PATHEXT, and missing entries", () => {
    const first = makeTempDir();
    const second = makeTempDir();
    writeFileSync(join(first, "tool.cmd"), "");
    writeFileSync(join(second, "tool.exe"), "");
    writeFileSync(join(second, "other.CMD"), "");
    writeFileSync(join(second, "bare"), "");
    mkdirSync(join(second, "folder.exe"));
    const env = {
      PATH: [join(first, "missing"), first, second].join(";"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };
    const options = { platform: "win32" as const, env };
    const resolve = createBatchExecutableResolver(options);

    for (const command of ["tool", "other", "bare", "folder", "absent", "tool.exe"]) {
      expect(resolve(command), command).toBe(resolveExecutable(command, options));
    }
    // Exact casing of the hit depends on the host filesystem's case sensitivity.
    expect(resolve("tool")?.toLowerCase()).toBe(join(first, "tool.cmd").toLowerCase());
    expect(resolve("other")?.toLowerCase()).toBe(join(second, "other.cmd").toLowerCase());
    expect(resolve("bare")).toBeNull();
    expect(resolve("folder")).toBeNull();
  });

  const posixOnly = it.skipIf(process.platform === "win32" || process.getuid?.() === 0);

  posixOnly("honors the executable bit on POSIX", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "runnable"), "", { mode: 0o755 });
    writeFileSync(join(dir, "plain"), "", { mode: 0o644 });
    const options = { platform: "linux" as const, env: { PATH: dir } };
    const resolve = createBatchExecutableResolver(options);

    expect(resolve("runnable")).toBe(join(dir, "runnable"));
    expect(resolve("plain")).toBeNull();
    expect(resolve("plain")).toBe(resolveExecutable("plain", options));
  });

  posixOnly("falls back to stat for PATH directories that cannot be listed", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "hidden-tool"), "", { mode: 0o755 });
    chmodSync(dir, 0o111);
    try {
      const options = { platform: "linux" as const, env: { PATH: dir } };

      expect(createBatchExecutableResolver(options)("hidden-tool")).toBe(join(dir, "hidden-tool"));
      expect(resolveExecutable("hidden-tool", options)).toBe(join(dir, "hidden-tool"));
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("delegates qualified commands to resolveExecutable", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "tool.exe"), "");
    const options = { platform: "win32" as const, env: { PATH: "", PATHEXT: ".EXE" } };

    expect(createBatchExecutableResolver(options)(join(dir, "tool"))).toBe(
      resolveExecutable(join(dir, "tool"), options),
    );
  });
});
