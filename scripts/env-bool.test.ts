// FILE: env-bool.test.ts
// Purpose: Verifies permissive boolean env parsing for release scripts.
// Layer: Release/build tests
// Depends on: scripts/lib/env-bool.ts.

import { assert, describe, it } from "@effect/vitest";

import { parseBooleanEnvValue, parseOptionalBooleanEnvValue } from "./lib/env-bool.ts";

describe("env-bool", () => {
  it("accepts common true and false spellings", () => {
    for (const value of ["1", "true", "TRUE", "yes", "y", "on"]) {
      assert.equal(parseBooleanEnvValue("TEST_FLAG", value), true);
    }
    for (const value of ["0", "false", "FALSE", "no", "n", "off", ""]) {
      assert.equal(parseBooleanEnvValue("TEST_FLAG", value), false);
    }
  });

  it("uses the default only when the env value is missing", () => {
    assert.equal(parseOptionalBooleanEnvValue("TEST_FLAG", undefined, true), true);
    assert.equal(parseOptionalBooleanEnvValue("TEST_FLAG", "0", true), false);
  });

  it("rejects ambiguous values", () => {
    assert.throws(() => parseBooleanEnvValue("TEST_FLAG", "maybe"), /TEST_FLAG/);
  });
});
