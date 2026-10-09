import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReleaseBuildScope } from "./lib/release-build-scope.ts";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const build = workflow.slice(workflow.indexOf("  build:\n"), workflow.indexOf("  publish_cli:\n"));

describe("Linux release packaging wiring", () => {
  it("uses one Linux runner/native preparation with the same declared targets in all gates", () => {
    const scope = resolveReleaseBuildScope("all", "artifact", true);
    expect(scope.matrix.include.filter((entry) => entry.platform === "linux")).toHaveLength(1);
    expect(scope.cua_matrix.include.filter((entry) => entry.platform === "linux")).toHaveLength(1);
    expect(build).toContain(
      "ARTIFACT_TARGET: ${{ matrix.platform == 'linux' && 'AppImage,deb' || matrix.target }}",
    );
    expect(build.match(/--target "\$ARTIFACT_TARGET"/g)).toHaveLength(3);
    expect(build).toContain("libcrypt1 dpkg-dev xz-utils xvfb xauth");
    expect(build).toContain("name: desktop-${{ matrix.platform }}-${{ matrix.arch }}");
  });

  it.skipIf(process.platform === "win32")(
    "collects the actual Debian payload without unrelated outputs",
    () => {
      const root = mkdtempSync(join(tmpdir(), "synara-linux-collect-test-"));
      try {
        mkdirSync(join(root, "release"));
        for (const name of [
          "Synara.AppImage",
          "Synara.deb",
          "latest-linux.yml",
          "Synara.rpm",
          "builder-debug.yml",
          "unrelated.txt",
        ])
          writeFileSync(join(root, "release", name), name);
        const step = build.slice(
          build.indexOf("      - name: Collect release assets"),
          build.indexOf("      - name: Verify and record artifact provenance"),
        );
        const script = step
          .slice(step.indexOf("        run: |\n") + "        run: |\n".length)
          .replace(/^          /gm, "")
          .replaceAll("${{ matrix.platform }}", "linux")
          .replaceAll("${{ matrix.arch }}", "x64");
        const result = spawnSync("bash", ["-c", script], { cwd: root, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(readdirSync(join(root, "release-publish")).toSorted()).toEqual([
          "Synara.AppImage",
          "Synara.deb",
          "latest-linux.yml",
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("publishes Debian packages as release downloads, not as pinned updater payloads", () => {
    const publish = workflow.slice(
      workflow.indexOf("      - name: Publish release"),
      workflow.indexOf("      - name: Mirror Synara artifacts"),
    );
    const mirror = workflow.slice(
      workflow.indexOf("      - name: Mirror Synara artifacts"),
      workflow.indexOf("  finalize:\n"),
    );
    expect(publish).toContain("release-assets/*.deb");
    expect(mirror).toContain("release-assets/*.AppImage");
    expect(mirror).not.toContain("release-assets/*.deb");
    expect(workflow).not.toContain("release-assets/*.rpm");
    const scripts = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).scripts;
    expect(scripts["dist:desktop:linux"]).toContain("--target AppImage --arch x64");
    expect(scripts["dist:desktop:linux:deb"]).toContain("--target deb --arch x64");
  });
});
