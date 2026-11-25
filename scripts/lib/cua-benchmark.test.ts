import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("prepares complete Cua snapshots before any compiler or network operation", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const output = mkdtempSync(join(tmpdir(), "cua-benchmark-inputs-test-"));
  const fixture = join(output, "repository");
  mkdirSync(fixture);
  // The script benchmarks committed inputs, but this regression must also run
  // before the feature is committed or while an integration merge is pending.
  // Own the Git fixture instead of assuming the caller's HEAD contains these files.
  for (const relative of [
    "package.json",
    "packages/shared/src/cuaDriverRelease.json",
    "apps/desktop/patches/cua-driver",
    "apps/desktop/scripts",
    "scripts/lib/build-timing.ts",
    "docs/computer-use-cua/CUA-LICENSE.txt",
    "scripts/computer-use-fixtures/probe-native-cancellation.mjs",
  ]) {
    mkdirSync(dirname(join(fixture, relative)), { recursive: true });
    cpSync(join(root, relative), join(fixture, relative), { recursive: true });
  }
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: fixture, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  try {
    git("init", "--quiet");
    git("add", ".");
    git("commit", "--quiet", "-m", "Isolated benchmark inputs");
    const head = git("rev-parse", "HEAD").trim();
    const result = execFileSync(
      process.execPath,
      [join(root, "scripts/benchmark-cua-build.ts"), head, output, "--prepare-only"],
      { cwd: fixture, encoding: "utf8" },
    );
    expect(result).toContain(`prepared baseline: ${head}; license and patch verified`);
    expect(result).toContain(`prepared candidate: ${head}; license and patch verified`);
    expect(result).not.toContain("fresh Cargo home");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
