import { assert, describe, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyMacAppSignature } from "./lib/mac-update-zip-finalize.ts";

const CUA_BUNDLE_ID = "com.emanueledipietro.synara.cua";

function withTemporaryMacApp(
  test: (appPath: string) => void,
  bundleId: string = CUA_BUNDLE_ID,
): void {
  const root = mkdtempSync(join(tmpdir(), "synara-signature-test-"));
  const appPath = join(root, "Synara Cua Signature Test.app");
  try {
    mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(appPath, "Contents", "Resources"));
    const executable = join(appPath, "Contents", "MacOS", "probe");
    // This copied executable is never launched. A real signature on a tiny
    // fixture exercises macOS validation without rebuilding/signing Synara.
    copyFileSync("/usr/bin/true", executable);
    chmodSync(executable, 0o755);
    writeFileSync(
      join(appPath, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>Synara Cua Signature Test</string>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`,
    );
    writeFileSync(join(appPath, "Contents", "Resources", "fixture.txt"), "original");
    test(appPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function signFixture(appPath: string, identifier: string = CUA_BUNDLE_ID): void {
  execFileSync(
    "codesign",
    ["--force", "--sign", "-", "--timestamp=none", "--identifier", identifier, appPath],
    { stdio: "pipe" },
  );
}

describe.skipIf(process.platform !== "darwin")("macOS packaged app identity", () => {
  it("accepts an ad-hoc sealed bundle with the Cua code and Info.plist identity", () => {
    withTemporaryMacApp((appPath) => {
      signFixture(appPath);
      verifyMacAppSignature(appPath, false, CUA_BUNDLE_ID);
    });
  });

  it("rejects an unsealed executable even when release signing is not requested", () => {
    withTemporaryMacApp((appPath) => {
      assert.throws(
        () => verifyMacAppSignature(appPath, false, CUA_BUNDLE_ID),
        /Expected a sealed macOS app signature/,
      );
      // Production build-only artifacts retain their existing optional policy.
      verifyMacAppSignature(appPath, false);
    });
  });

  it("rejects a sealed bundle carrying a different code identifier", () => {
    withTemporaryMacApp((appPath) => {
      signFixture(appPath, "Electron");
      assert.throws(() => verifyMacAppSignature(appPath, false, CUA_BUNDLE_ID));
    });
  });

  it("rejects a correct code identifier paired with a different sealed Info.plist identity", () => {
    withTemporaryMacApp((appPath) => {
      signFixture(appPath);
      assert.throws(() => verifyMacAppSignature(appPath, false, CUA_BUNDLE_ID));
    }, "com.emanueledipietro.synara");
  });

  it("rejects resources changed after signing", () => {
    withTemporaryMacApp((appPath) => {
      signFixture(appPath);
      writeFileSync(join(appPath, "Contents", "Resources", "fixture.txt"), "modified");
      assert.throws(() => verifyMacAppSignature(appPath, false, CUA_BUNDLE_ID));
    });
  });
});
