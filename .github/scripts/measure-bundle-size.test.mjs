import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  inventory,
  readAsar,
  selectBuildStage,
  selectPackagedApplication,
  summarize,
} from "./measure-bundle-size.mjs";

const sourceCommit = "a".repeat(40);
const lockfileSha256 = "b".repeat(64);
const version = "1.0.1";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "synara-size-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stageParent = join(root, "owned-temp");
  mkdirSync(stageParent);
  const options = {
    stageParent,
    platform: "linux",
    flavor: "production",
    sourceCommit,
    lockfileSha256,
    version,
  };
  function stage(name = "synara-desktop-production-linux-stage-first", overrides = {}) {
    const stageRoot = join(stageParent, name);
    mkdirSync(join(stageRoot, "app", "dist"), { recursive: true });
    writeFileSync(
      join(stageRoot, "app", "package.json"),
      JSON.stringify({
        synaraCommitHash: sourceCommit,
        synaraLockfileSha256: lockfileSha256,
        synaraDesktopFlavor: "production",
        version,
        ...overrides,
      }),
    );
    return stageRoot;
  }
  return { root, options, stage };
}

test("selects the current builder's flavor-qualified stage in the explicit owned parent", (t) => {
  const { options, stage } = fixture(t);
  const expected = stage();
  stage("synara-desktop-linux-stage-obsolete", { synaraCommitHash: "old" });
  stage("synara-desktop-beta-linux-stage-other-flavor", { synaraDesktopFlavor: "beta" });
  assert.equal(selectBuildStage(options), expected);
});

test("missing candidates fail instead of using another temp parent or obsolete prefix", (t) => {
  const { root, options, stage } = fixture(t);
  mkdirSync(join(root, "synara-desktop-production-linux-stage-unrelated"));
  stage("synara-desktop-linux-stage-obsolete");
  assert.throws(() => selectBuildStage(options), /found 0/);
});

test("ambiguous candidates fail even when one is newer", (t) => {
  const { options, stage } = fixture(t);
  const first = stage();
  const second = stage("synara-desktop-production-linux-stage-second");
  utimesSync(first, 1, 1);
  utimesSync(second, 2, 2);
  assert.throws(() => selectBuildStage(options), /found 2/);
});

test("an incomplete matching stage cannot be hidden by a completed candidate", (t) => {
  const { options, stage } = fixture(t);
  stage();
  mkdirSync(join(options.stageParent, "synara-desktop-production-linux-stage-incomplete"));
  assert.throws(() => selectBuildStage(options), /found 2/);
});

test("a lone incomplete stage fails without reporting measurements", (t) => {
  const { options } = fixture(t);
  mkdirSync(join(options.stageParent, "synara-desktop-production-linux-stage-incomplete"));
  assert.throws(() => selectBuildStage(options), /no packaged output/);
});

for (const [key, stale] of [
  ["synaraCommitHash", "c".repeat(40)],
  ["synaraLockfileSha256", "d".repeat(64)],
  ["synaraDesktopFlavor", "beta"],
  ["version", "0.0.1"],
]) {
  test(`rejects a stage whose ${key} does not match the requested build`, (t) => {
    const { options, stage } = fixture(t);
    stage(undefined, { [key]: stale });
    assert.throws(() => selectBuildStage(options), new RegExp(`${key} mismatch`));
  });
}

for (const [platform, arch, directory] of [
  ["mac", "x64", "mac"],
  ["mac", "arm64", "mac-arm64"],
  ["mac", "universal", "mac-universal"],
  ["linux", "x64", "linux-unpacked"],
  ["linux", "arm64", "linux-arm64-unpacked"],
  ["win", "x64", "win-unpacked"],
  ["win", "arm64", "win-arm64-unpacked"],
]) {
  test(`selects only the requested native ${platform}/${arch} package`, (t) => {
    const { root } = fixture(t);
    const dist = join(root, "dist");
    mkdirSync(join(dist, directory), { recursive: true });
    assert.equal(selectPackagedApplication(dist, platform, arch), join(dist, directory));
    assert.throws(
      () => selectPackagedApplication(dist, platform === "linux" ? "mac" : "linux", arch),
      /Packaged target mismatch/,
    );
  });
}

test("missing or multiple native packages cannot produce a report", (t) => {
  const { root } = fixture(t);
  const dist = join(root, "dist");
  mkdirSync(dist);
  assert.throws(() => selectPackagedApplication(dist, "linux", "x64"), /Expected one native/);
  mkdirSync(join(dist, "linux-unpacked"));
  mkdirSync(join(dist, "linux-arm64-unpacked"));
  assert.throws(() => selectPackagedApplication(dist, "linux", "x64"), /Expected one native/);
});

test("installed totals count archive and unpacked files once, separately from logical ASAR bytes", (t) => {
  const { root } = fixture(t);
  const packaged = join(root, "packaged");
  const unpacked = join(packaged, "app.asar.unpacked", "node_modules", "native");
  mkdirSync(unpacked, { recursive: true });
  writeFileSync(join(unpacked, "addon.node"), Buffer.alloc(7));
  const header = Buffer.from(
    JSON.stringify({
      files: {
        "index.js": { size: 5, offset: "0" },
        node_modules: {
          files: {
            native: { files: { "addon.node": { size: 7, unpacked: true } } },
          },
        },
        "linked.js": { link: "index.js" },
      },
    }),
  );
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(header.length, 12);
  const archive = join(packaged, "app.asar");
  writeFileSync(archive, Buffer.concat([prefix, header, Buffer.alloc(5)]));
  const installed = summarize(inventory(packaged));
  const asar = readAsar(archive);
  assert.equal(installed.fileCount, 2);
  assert.equal(installed.bytes, statSync(archive).size + 7);
  assert.equal(asar.bytes, 12);
  assert.equal(asar.fileCount, 2);
  assert.deepEqual(asar.packages, [{ name: "native", bytes: 7 }]);
  assert.equal(asar.files.find((file) => file.path.endsWith("addon.node")).unpacked, true);
});
