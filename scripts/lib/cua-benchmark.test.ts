import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("prepares complete Cua snapshots before any compiler or network operation", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const output = mkdtempSync(join(tmpdir(), "cua-benchmark-inputs-test-"));
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const result = execFileSync(
      process.execPath,
      [join(root, "scripts/benchmark-cua-build.ts"), head, output, "--prepare-only"],
      { cwd: root, encoding: "utf8" },
    );
    expect(result).toContain(`prepared baseline: ${head}; license and patch verified`);
    expect(result).toContain(`prepared candidate: ${head}; license and patch verified`);
    expect(result).not.toContain("fresh Cargo home");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
