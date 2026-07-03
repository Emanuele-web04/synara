import { assert, describe, it } from "@effect/vitest";

import { inspectMacCodeSignatureOutput } from "./lib/mac-code-signature.ts";

describe("inspectMacCodeSignatureOutput", () => {
  it("rejects ad-hoc signatures because macOS TCC permissions reset across builds", () => {
    const inspection = inspectMacCodeSignatureOutput(
      0,
      [
        "Executable=/Applications/Synara.app/Contents/Resources/Wandy.app/Contents/MacOS/Wandy",
        "Identifier=com.synara.wandy",
        "Signature=adhoc",
        "TeamIdentifier=not set",
      ].join("\n"),
    );

    assert.equal(inspection.isStable, false);
    assert.equal(inspection.details, "Signature=adhoc TeamIdentifier=not set");
  });

  it("accepts Developer ID signatures with a stable team identifier", () => {
    const inspection = inspectMacCodeSignatureOutput(
      0,
      [
        "Executable=/Applications/Synara.app/Contents/Resources/Wandy.app/Contents/MacOS/Wandy",
        "Identifier=com.synara.wandy",
        "Authority=Developer ID Application: Synara Labs, Inc. (TEAMID1234)",
        "TeamIdentifier=TEAMID1234",
      ].join("\n"),
    );

    assert.equal(inspection.isStable, true);
    assert.equal(inspection.details, "TeamIdentifier=TEAMID1234");
  });

  it("rejects failed codesign inspection", () => {
    const inspection = inspectMacCodeSignatureOutput(1, "code object is not signed at all");

    assert.equal(inspection.isStable, false);
    assert.equal(inspection.details, "codesign output: code object is not signed at all");
  });
});
