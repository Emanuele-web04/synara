import { describe, expect, it } from "vitest";

import {
  computerPermissionSetupMessage,
  computerStaleGrantAdvice,
} from "@synara/shared/computerGrants";
import { computerSetupSignal } from "./computerSetupSignal.ts";

const BUNDLE_ID = "com.synara.test";

describe("computer signature change", () => {
  it("an ad-hoc rebuild re-raises the missing grant with the stale-build explanation", () => {
    // macOS pins an ad-hoc grant to the binary's cdhash, so a rebuild
    // invalidates it while System Settings still shows the switch on.
    const message = computerPermissionSetupMessage(["accessibility"], "adhoc");
    expect(message).toContain("Synara needs Accessibility");
    expect(message).toContain("earlier build");
    const withReset = computerPermissionSetupMessage(["screenRecording"], "adhoc", BUNDLE_ID);
    expect(withReset).toContain("tccutil reset ScreenCapture com.synara.test");
    expect(
      computerStaleGrantAdvice(["accessibility", "screenRecording"], "adhoc", BUNDLE_ID),
    ).toContain("tccutil reset Accessibility com.synara.test");
  });

  it("a signed or unknown build never blames the cdhash", () => {
    // The rebuild advice would be a red herring on a release build, so the
    // card branch withholds it there.
    for (const signature of ["signed", "unknown"] as const) {
      expect(computerPermissionSetupMessage(["accessibility"], signature)).not.toContain(
        "earlier build",
      );
      expect(computerPermissionSetupMessage(["accessibility"], signature)).not.toContain("tccutil");
      expect(computerStaleGrantAdvice(["accessibility"], signature, BUNDLE_ID)).toBeNull();
    }
  });

  it("the card branch carries the signature while the grant stays missing", () => {
    const availability = {
      kind: "permission-required",
      missing: ["accessibility"],
      buildSignature: "adhoc",
      bundleId: BUNDLE_ID,
      message: "Synara needs Accessibility to control this Mac. Turn Synara on in…",
    } as const;
    const first = computerSetupSignal({ availability, bundleId: BUNDLE_ID });
    expect(first).toMatchObject({
      missing: ["accessibility"],
      blocking: true,
      buildSignature: "adhoc",
      bundleId: BUNDLE_ID,
    });
    // A rebuild that still lacks the grant re-raises the same signal: the
    // pure decision never latches a previous answer away.
    const second = computerSetupSignal({ availability, bundleId: BUNDLE_ID });
    expect(second).toMatchObject({
      missing: ["accessibility"],
      blocking: true,
      buildSignature: "adhoc",
    });
    // And a desktop with every grant in place raises no card at all.
    expect(computerSetupSignal({ missing: [], bundleId: BUNDLE_ID })).toBeUndefined();
  });
});
