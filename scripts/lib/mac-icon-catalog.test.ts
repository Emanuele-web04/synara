import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SYNARA_PACKAGED_DESKTOP_FLAVORS } from "@synara/shared/desktopIdentity";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { desktopIconAssetPaths } from "./brand-assets.ts";
import {
  collectMacIconCatalogInputs,
  MAC_ICON_CATALOG_FILE,
  MAC_ICON_FLAVORS,
  MAC_ICON_PROVENANCE_FILE,
  MAC_ICON_RELEASE_DEVELOPER_DIR,
  MAC_ICON_RELEASE_RUNNER,
  macIconActoolArguments,
  macIconCatalogKey,
  parseMacIconFlavor,
  verifyMacIconCatalogDirectory,
} from "./mac-icon-catalog.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temporary = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const developerDirs = (steps: Array<{ env?: Record<string, string> }>) =>
  steps.flatMap((step) => (step.env?.DEVELOPER_DIR ? [step.env.DEVELOPER_DIR] : []));

// A repository copy holding only the key's inputs.
function iconRepository() {
  const root = temporary("synara-icon-key-");
  for (const path of [
    "scripts/lib/mac-icon-catalog.ts",
    "scripts/mac-icon-catalog.ts",
    "assets/prod/Synara.icon/icon.json",
    "assets/prod/Synara.icon/Assets/glyph.png",
    "assets/beta/Synara.icon/icon.json",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repoRoot, path), join(root, path));
  }
  return root;
}

describe("release macOS icon catalog identity", () => {
  it("accepts every packaged flavor and rejects anything else", () => {
    expect([...MAC_ICON_FLAVORS].toSorted()).toEqual(
      [...SYNARA_PACKAGED_DESKTOP_FLAVORS].toSorted(),
    );
    for (const flavor of SYNARA_PACKAGED_DESKTOP_FLAVORS)
      expect(parseMacIconFlavor(flavor)).toBe(flavor);
    for (const invalid of ["Beta", "prod", "", undefined])
      expect(() => parseMacIconFlavor(invalid)).toThrow("Unknown macOS icon flavor");
  });

  it("shares one key between flavors that ship the same Icon Composer source", () => {
    const key = (flavor: (typeof MAC_ICON_FLAVORS)[number]) =>
      macIconCatalogKey(collectMacIconCatalogInputs(repoRoot, flavor));
    expect(key("remote")).toBe(key("production"));
    expect(key("beta")).not.toBe(key("production"));
    expect(key("production")).toMatch(/^mac-icon-v1-[a-f0-9]{64}$/);
  });

  it("changes the key with source bytes, added files and the producing code", () => {
    const root = iconRepository();
    const key = () => macIconCatalogKey(collectMacIconCatalogInputs(root, "production"));
    const original = key();
    const glyph = join(root, "assets/prod/Synara.icon/Assets/glyph.png");
    writeFileSync(glyph, Buffer.concat([readFileSync(glyph), Buffer.from([0])]));
    const changedBytes = key();
    expect(changedBytes).not.toBe(original);
    writeFileSync(join(root, "assets/prod/Synara.icon/Assets/extra.png"), "layer");
    expect(key()).not.toBe(changedBytes);
    const afterAdd = key();
    writeFileSync(join(root, "scripts/mac-icon-catalog.ts"), "// changed compile\n", {
      flag: "a",
    });
    expect(key()).not.toBe(afterAdd);
  });

  it("refuses links inside the Icon Composer source", () => {
    const root = iconRepository();
    symlinkSync("/etc/hosts", join(root, "assets/prod/Synara.icon/Assets/linked.png"));
    expect(() => collectMacIconCatalogInputs(root, "production")).toThrow("non-regular file");
  });

  it.each(["actool", "runner", "xcodeVersion", "developerDir", "source"] as const)(
    "invalidates a changed %s",
    (field) => {
      const inputs = collectMacIconCatalogInputs(repoRoot, "production");
      expect(macIconCatalogKey({ ...inputs, [field]: "changed" })).not.toBe(
        macIconCatalogKey(inputs),
      );
    },
  );

  it("compiles the catalog the bundle names, for macOS 26", () => {
    expect(macIconActoolArguments("in.icon", "out", "partial.plist")).toEqual([
      "actool",
      "in.icon",
      "--compile",
      "out",
      "--platform",
      "macosx",
      "--minimum-deployment-target",
      "26.0",
      "--app-icon",
      "Synara",
      "--include-all-app-icons",
      "--output-partial-info-plist",
      "partial.plist",
      "--output-format",
      "human-readable-text",
    ]);
  });
});

describe("cached macOS icon catalog verification", () => {
  const key = `mac-icon-v1-${"a".repeat(64)}`;
  const source = "assets/prod/Synara.icon";
  function catalogDirectory(
    overrides: Record<string, unknown> = {},
    catalog = Buffer.from("BOMStore compiled catalog"),
  ) {
    const directory = temporary("synara-icon-catalog-");
    writeFileSync(join(directory, MAC_ICON_CATALOG_FILE), catalog);
    writeFileSync(
      join(directory, MAC_ICON_PROVENANCE_FILE),
      JSON.stringify({
        key,
        source,
        catalogSha256: createHash("sha256").update(catalog).digest("hex"),
        xcode: "Xcode 26.3\nBuild version 17A1",
        actool: "short-bundle-version: 26.3",
        macos: "26.1 (25B78)",
        ...overrides,
      }),
    );
    return directory;
  }

  it("accepts exactly the catalog and provenance recorded for this key", () => {
    expect(verifyMacIconCatalogDirectory(catalogDirectory(), { key, source }).key).toBe(key);
  });

  it.each([
    ["another key", { key: `mac-icon-v1-${"b".repeat(64)}` }, "different key"],
    ["another source", { source: "assets/beta/Synara.icon" }, "different Icon Composer source"],
    ["another Xcode", { xcode: "Xcode 26.4\nBuild version 17B1" }, "pinned Xcode"],
    ["a similar Xcode", { xcode: "Xcode 26.30\nBuild version 17B1" }, "pinned Xcode"],
    ["changed bytes", { catalogSha256: "0".repeat(64) }, "do not match"],
  ])("rejects %s", (_, overrides, message) => {
    expect(() =>
      verifyMacIconCatalogDirectory(catalogDirectory(overrides), { key, source }),
    ).toThrow(message);
  });

  it("rejects empty catalogs, extra files and malformed keys", () => {
    expect(() =>
      verifyMacIconCatalogDirectory(catalogDirectory({}, Buffer.alloc(0)), { key, source }),
    ).toThrow("not a compiled asset catalog");
    const extra = catalogDirectory();
    writeFileSync(join(extra, "Synara.icns"), "icns");
    expect(() => verifyMacIconCatalogDirectory(extra, { key, source })).toThrow("Unexpected");
    expect(() =>
      verifyMacIconCatalogDirectory(catalogDirectory(), { key: "cua-v1-x", source }),
    ).toThrow("Invalid macOS icon catalog key");
  });
});

describe("macOS icon catalog workflows", () => {
  const workflow = (name: string) =>
    parse(readFileSync(join(repoRoot, ".github/workflows", name), "utf8")) as {
      jobs: Record<
        string,
        {
          "runs-on": string;
          strategy?: { matrix: { flavor: string[] } };
          steps: Array<{ env?: Record<string, string>; run?: string }>;
        }
      >;
    };
  it("pre-compiles every Icon Composer source a packaged flavor can ship", () => {
    const producer = workflow("cua-release-cache.yml").jobs.mac_icon!;
    const produced = new Set(
      producer.strategy!.matrix.flavor.map(
        (flavor) => desktopIconAssetPaths(parseMacIconFlavor(flavor)).macIconComposer,
      ),
    );
    for (const flavor of SYNARA_PACKAGED_DESKTOP_FLAVORS)
      expect(produced.has(desktopIconAssetPaths(flavor).macIconComposer), flavor).toBe(true);
  });

  it("compiles on the runner and Xcode that the cache key claims", () => {
    for (const job of [
      workflow("cua-release-cache.yml").jobs.mac_icon!,
      workflow("release.yml").jobs.build_mac_icon!,
    ]) {
      expect(job["runs-on"]).toBe(MAC_ICON_RELEASE_RUNNER);
      expect(developerDirs(job.steps)).toEqual([MAC_ICON_RELEASE_DEVELOPER_DIR]);
      expect(
        job.steps.some((step) => step.run?.includes("scripts/mac-icon-catalog.ts compile")),
      ).toBe(true);
    }
  });
});
