import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { finalizeLinuxAppImageUpdateFeed } from "./linux-appimage-update-feed.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options?: {
  readonly arch?: "x64" | "arm64";
  readonly wrongImageHash?: boolean;
  readonly unknownPayload?: boolean;
  readonly noImageEntry?: boolean;
  readonly wrongVersion?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "synara-linux-appimage-feed-"));
  roots.push(root);
  const image = "Synara-1.0.3-x86_64.AppImage";
  const deb = "Synara-1.0.3-amd64.deb";
  const rpm = "Synara-1.0.3-x86_64.rpm";
  const content = Buffer.from("real-appimage-payload");
  const digest = createHash("sha512").update(content).digest("base64");
  writeFileSync(join(root, image), content);
  writeFileSync(join(root, deb), "deb");
  writeFileSync(join(root, rpm), "rpm");
  const manifestName =
    options?.arch === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml";
  const imageRecord = `  - url: ${image}\n    sha512: ${options?.wrongImageHash ? "invalid-hash" : digest}\n    size: ${content.length}\n`;
  writeFileSync(
    join(root, manifestName),
    `version: ${options?.wrongVersion ? "0.0.1" : "1.0.3"}\nfiles:\n` +
      (options?.noImageEntry ? "" : imageRecord) +
      `  - url: ${deb}\n    sha512: deb-digest\n    size: 3\n` +
      `  - url: ${rpm}\n    sha512: rpm-digest\n    size: 3\n` +
      (options?.unknownPayload
        ? "  - url: unknown.zip\n    sha512: unknown\n    size: 5\n"
        : "") +
      `path: ${rpm}\nsha512: rpm-digest\nreleaseDate: '2026-10-17T00:00:00Z'\n`,
  );
  return { root, manifestName, image, digest };
}

describe("Linux AppImage update manifest finalization", () => {
  it.each(["x64", "arm64"] as const)(
    "retains only the real AppImage with a matching updater pointer on %s",
    async (arch) => {
      const { root, manifestName, image, digest } = fixture({ arch });
      const output = await finalizeLinuxAppImageUpdateFeed({
        stageDistDir: root,
        arch,
        version: "1.0.3",
      });
      expect(output).toBe(join(root, manifestName));
      const content = readFileSync(output, "utf8");
      expect(content).toContain(`url: ${image}`);
      expect(content).toContain(`path: ${image}`);
      expect(content).toContain(`sha512: ${digest}`);
      expect(content).toContain("releaseDate:");
      expect(content).not.toContain(".deb");
      expect(content).not.toContain(".rpm");
    },
  );

  it("fails closed when the AppImage hash is wrong without rewriting the feed", async () => {
    const { root, manifestName } = fixture({ wrongImageHash: true });
    const before = readFileSync(join(root, manifestName), "utf8");
    await expect(
      finalizeLinuxAppImageUpdateFeed({ stageDistDir: root, arch: "x64", version: "1.0.3" }),
    ).rejects.toThrow("does not match");
    expect(readFileSync(join(root, manifestName), "utf8")).toBe(before);
  });

  it.each([
    ["unknown payload", { unknownPayload: true }, "Unexpected Linux updater payload"],
    ["missing AppImage", { noImageEntry: true }, "exactly one packaged AppImage"],
    ["wrong version", { wrongVersion: true }, "version differs"],
  ] as const)("rejects %s", async (_label, options, message) => {
    const { root } = fixture(options);
    await expect(
      finalizeLinuxAppImageUpdateFeed({ stageDistDir: root, arch: "x64", version: "1.0.3" }),
    ).rejects.toThrow(message);
  });
});
