import { describe, expect, it } from "vitest";
import {
  decideRemoteBillingAccess,
  REMOTE_BILLING_MAX_STATUS_AGE_MS,
  type RemoteBillingAccessInput,
} from "./accessPolicy";

const nowMs = Date.parse("2026-10-27T12:00:00.000Z");
const granted = {
  available: true,
  access: "granted" as const,
  checkedAt: new Date(nowMs).toISOString(),
  validUntil: new Date(nowMs + 60_000).toISOString(),
};
const unavailable = { allowed: false, reason: "billing_unavailable" };

describe("remote subscription admission policy", () => {
  it("leaves existing access policy unchanged until explicitly enabled", () => {
    expect(decideRemoteBillingAccess()).toEqual({ allowed: true, reason: "allowed" });
    expect(
      decideRemoteBillingAccess({ enforcementEnabled: false, status: null, nowMs: Number.NaN }),
    ).toEqual({ allowed: true, reason: "allowed" });
  });

  it("admits a freshly granted benefit without inventing a subscription-status rule", () => {
    for (const validUntil of [granted.validUntil, null]) {
      expect(
        decideRemoteBillingAccess({
          enforcementEnabled: true,
          nowMs,
          status: { ...granted, validUntil },
        }),
      ).toEqual({ allowed: true, reason: "allowed" });
    }
  });

  it("distinguishes a fresh subscription refusal from unavailable verification", () => {
    expect(
      decideRemoteBillingAccess({
        enforcementEnabled: true,
        nowMs,
        status: { ...granted, access: "none", validUntil: null },
      }),
    ).toEqual({ allowed: false, reason: "subscription_required" });
    for (const status of [undefined, null, { ...granted, available: false }]) {
      expect(decideRemoteBillingAccess({ enforcementEnabled: true, nowMs, status })).toEqual(
        unavailable,
      );
    }
  });

  it("does not reuse stale, future or malformed verification", () => {
    for (const checkedAt of [
      null,
      "invalid",
      new Date(nowMs + 1).toISOString(),
      new Date(nowMs - REMOTE_BILLING_MAX_STATUS_AGE_MS).toISOString(),
    ]) {
      expect(
        decideRemoteBillingAccess({
          enforcementEnabled: true,
          nowMs,
          status: { ...granted, checkedAt },
        }),
      ).toEqual(unavailable);
    }
  });

  it("bounds configurable freshness without granting additional offline time", () => {
    const status = { ...granted, checkedAt: new Date(nowMs - 1000).toISOString() };
    expect(
      decideRemoteBillingAccess({ enforcementEnabled: true, nowMs, status, maxStatusAgeMs: 1001 }),
    ).toEqual({ allowed: true, reason: "allowed" });
    for (const maxStatusAgeMs of [1000, 0, -1, 60_001, Number.POSITIVE_INFINITY]) {
      expect(
        decideRemoteBillingAccess({ enforcementEnabled: true, nowMs, status, maxStatusAgeMs }),
      ).toEqual(unavailable);
    }
  });

  it("requires a usable server clock and does not treat an expired positive state as unpaid", () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        decideRemoteBillingAccess({ enforcementEnabled: true, nowMs: now, status: granted }),
      ).toEqual(unavailable);
    }
    for (const validUntil of ["invalid", new Date(nowMs).toISOString()]) {
      const input: RemoteBillingAccessInput = {
        enforcementEnabled: true,
        nowMs,
        status: { ...granted, validUntil },
      };
      expect(decideRemoteBillingAccess(input)).toEqual(unavailable);
    }
  });
});
