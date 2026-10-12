import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertPackagedThirdPartyNotice } from "./lib/desktop-artifact-notices.ts";

let root: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("packaged third-party notice verification", () => {
  it("accepts the exact notice staged inside packaged app resources", async () => {
    root = await mkdtemp(join(tmpdir(), "synara-artifact-notice-"));
    const resources = join(root, "mac-arm64", "Synara.app", "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    const expected = "# Third-party notices\nMIT License\n";
    await writeFile(join(resources, "THIRD_PARTY_NOTICES.md"), expected);

    await expect(assertPackagedThirdPartyNotice(root, expected)).resolves.toBeUndefined();
  });

  it("rejects a missing or altered packaged notice", async () => {
    root = await mkdtemp(join(tmpdir(), "synara-artifact-notice-"));
    const resources = join(root, "linux-unpacked", "resources");
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, "THIRD_PARTY_NOTICES.md"), "wrong notice");

    await expect(assertPackagedThirdPartyNotice(root, "expected notice")).rejects.toThrow(
      "Packaged app is missing the staged THIRD_PARTY_NOTICES.md resource.",
    );
    expect(await readFile(join(resources, "THIRD_PARTY_NOTICES.md"), "utf8")).toBe("wrong notice");
  });
});
