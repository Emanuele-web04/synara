import { it } from "@effect/vitest";
import { Cause } from "effect";
import { describe, expect } from "vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import { causeIndicatesAuthRequired, isAcpAuthRequiredError } from "./AcpSessionRuntime.ts";

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

  it("returns true when errorMessage contains 'authorization required'", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -1,
      errorMessage: "Authorization required",
    });
    expect(isAcpAuthRequiredError(error)).toBe(true);
  });

  it("returns true when errorMessage contains 'authentication expired'", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -1,
      errorMessage: "Authentication expired",
    });
    expect(isAcpAuthRequiredError(error)).toBe(true);
  });

  it("returns true when errorMessage contains 'auth' as a standalone word", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -1,
      errorMessage: "Auth required for this action",
    });
    expect(isAcpAuthRequiredError(error)).toBe(true);
  });

  it("returns false when errorMessage contains 'authoring' (not 'auth' as a word boundary)", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -1,
      errorMessage: "authoring mode is not supported",
    });
    expect(isAcpAuthRequiredError(error)).toBe(false);
  });

  it("returns true for AcpRequestError with code -32000 and empty string errorMessage", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: "",
    });
    expect(isAcpAuthRequiredError(error)).toBe(true);
  });

  it("returns true for code -32000 regardless of errorMessage content", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: "something unrelated",
    });
    expect(isAcpAuthRequiredError(error)).toBe(true);
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

  it("returns true for a Die cause with 'authorization required' message", () => {
    const cause = Cause.die(new Error("Authorization required"));
    expect(causeIndicatesAuthRequired(cause)).toBe(true);
  });

  it("returns true for a Die cause with 'authentication expired' message", () => {
    const cause = Cause.die(new Error("Authentication expired"));
    expect(causeIndicatesAuthRequired(cause)).toBe(true);
  });

  it("returns true for a Die cause with 'auth required' message", () => {
    const cause = Cause.die(new Error("Auth required"));
    expect(causeIndicatesAuthRequired(cause)).toBe(true);
  });

  it("returns false for a Die cause with 'author' in the message (no auth word boundary)", () => {
    const cause = Cause.die(new Error("the author field is missing"));
    expect(causeIndicatesAuthRequired(cause)).toBe(false);
  });

  it("returns false for a Die cause with a non-auth error", () => {
    const cause = Cause.die(new Error("Internal server error"));
    expect(causeIndicatesAuthRequired(cause)).toBe(false);
  });

  it("returns false for a Die cause with a non-string defect (number)", () => {
    const cause = Cause.die(42);
    expect(causeIndicatesAuthRequired(cause)).toBe(false);
  });

  it("returns false for a Die cause with a non-string defect (object)", () => {
    const cause = Cause.die({ foo: "bar" });
    expect(causeIndicatesAuthRequired(cause)).toBe(false);
  });

  it("returns false for an Empty cause", () => {
    expect(causeIndicatesAuthRequired(Cause.empty)).toBe(false);
  });
});
