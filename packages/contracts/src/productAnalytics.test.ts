import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProductAnalyticsEnvelope } from "./productAnalytics";
import { isReliabilityCode } from "./reliability";

const isEnvelope = Schema.is(ProductAnalyticsEnvelope);
const attempt = {
  v: 1,
  id: "11111111-2222-4333-8444-555555555555",
  ts: "2026-11-21T12:00:00.000Z",
  installId: "00000000-0000-4000-8000-000000000000",
  channel: "stable",
  surface: "ios",
  platform: "ios",
  appVersion: "1.2.3",
  event: "connection.connect",
  outcome: "failed",
  mode: "remote",
} as const;

describe("ProductAnalyticsEnvelope connection detail", () => {
  it("accepts the fixed connection failure, network and route values", () => {
    expect(
      isEnvelope({
        ...attempt,
        failure: "tls_handshake",
        httpStatus: 503,
        network: "cellular",
        route: "tunnel",
      }),
    ).toBe(true);
    // Turn categories remain valid on the same field.
    expect(
      isEnvelope({ ...attempt, event: "turn.completed", failure: "edge_blocked", httpStatus: 403 }),
    ).toBe(true);
  });

  it.each([
    ["free-text failure", { failure: "connect ECONNREFUSED 192.0.2.4:443" }],
    ["unknown network", { network: "5g" }],
    ["unknown route", { route: "relay" }],
    ["hostname route", { route: "host.example.test" }],
    ["out-of-range status", { failure: "route_upgrade", httpStatus: 600 }],
  ])("rejects a %s", (_label, patch) => {
    expect(isEnvelope({ ...attempt, ...patch })).toBe(false);
  });
});

describe("remote ingress reliability codes", () => {
  it.each([
    "remote.admission_refused",
    "remote.authorization_failed",
    "remote.authorization_denied",
    "remote.authorization_subscription_required",
    "remote.tunnel_provision_failed",
    "remote.connector_exited",
  ])("accepts %s", (code) => {
    expect(isReliabilityCode(code)).toBe(true);
  });

  it("rejects codes carrying detail", () => {
    expect(isReliabilityCode("remote.authorization_failed: 503")).toBe(false);
  });
});
