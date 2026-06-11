import { it } from "@effect/vitest";
import { Cause } from "effect";
import { describe, expect } from "vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  causeIndicatesAuthRequired,
  isAcpAuthRequiredError,
} from "./AcpSessionRuntime.ts";

describe("isAcpAuthRequiredError", () => {
  it("returns true for ACP auth-required code (-32000)", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: "Some error",
    });
    expect(isAcpAuthRequiredError(error)).toBe(true);
  });

  it("returns true when errorMessage contains 'authentication required'", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -1,
      errorMessage: "Authentication required",
    });
    expect(isAcpAuthRequiredError(error)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -1,
      errorMessage: "the author field is missing",
    });
    expect(isAcpAuthRequiredError(error)).toBe(false);
  });

  it("returns false for non-AcpRequestError tags", () => {
    const error = new EffectAcpErrors.AcpSpawnError({
      command: "devin",
      cause: new Error("spawn failed"),
    });
    expect(isAcpAuthRequiredError(error)).toBe(false);
  });
});

describe("causeIndicatesAuthRequired", () => {
  it("returns true for a Fail cause with auth-required code", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: "Unauthorized",
    });
    const cause = Cause.fail(error);
    expect(causeIndicatesAuthRequired(cause)).toBe(true);
  });

  it("returns true for a Die cause with 'authentication failed' message", () => {
    const cause = Cause.die(new Error("Devin authentication failed"));
    expect(causeIndicatesAuthRequired(cause)).toBe(true);
  });

  it("returns false when Cause.pretty would contain 'auth' in a path but there is no auth failure", () => {
    // This simulates a non-auth error whose stack trace or message happens
    // to include "auth" in a file path — the old Cause.pretty fallback would
    // have falsely triggered an auth retry.
    const cause = Cause.die(new Error("Module not found: /src/auth/utils.ts"));
    expect(causeIndicatesAuthRequired(cause)).toBe(false);
  });

  it("returns false for a Die cause with 'the author field is missing'", () => {
    const cause = Cause.die(new Error("the author field is missing"));
    expect(causeIndicatesAuthRequired(cause)).toBe(false);
  });

  it("returns false for a plain non-auth Fail cause", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -32603,
      errorMessage: "Internal error",
    });
    const cause = Cause.fail(error);
    expect(causeIndicatesAuthRequired(cause)).toBe(false);
  });
});
