// compression eligibility is decided from the raw upgrade target before routing, so it must agree with the router's matching semantics — a spelling the router sends to pre-auth bootstrap while this says "compressed" is a live zlib-amplification bypass; this table is the security boundary

import { describe, expect, it } from "vitest";

import { upgradePathAllowsCompression } from "./nodeHttpServer";

describe("upgradePathAllowsCompression", () => {
  it("allows the feature route in every spelling the router accepts", () => {
    for (const target of [
      "/ws",
      "/ws?token=abc",
      "/ws#fragment",
      "/WS",
      "/Ws",
      "/ws/",
      "/ws//",
      "//ws",
      "http://host/ws",
      "https://host:8080/ws?x=1",
    ]) {
      expect(upgradePathAllowsCompression(target), target).toBe(true);
    }
  });

  it("refuses every spelling that routes to the pre-auth bootstrap route", () => {
    for (const target of [
      "/ws/bootstrap",
      "/WS/BOOTSTRAP",
      "/Ws/BootStrap",
      "/ws//bootstrap",
      "/ws/bootstrap/",
      "/ws/%62ootstrap",
      "/ws/%42OOTSTRAP",
      "/ws/bootstrap;sid=1",
      "/ws/bootstrap?x=1",
      "http://host/ws/bootstrap",
      "https://host/WS/BOOTSTRAP",
    ]) {
      expect(upgradePathAllowsCompression(target), target).toBe(false);
    }
  });

  it("fails closed on unknown, malformed, and hostile targets", () => {
    for (const target of [
      undefined,
      "",
      "/",
      "/wsx",
      "/ws/negotiate",
      "/ws/..",
      "/ws/%2e%2e/ws",
      // invalid percent-encoding throws on decode — the raw target stands and can't match the feature route
      "/ws/%zz",
      "/%C0%AFws",
      "/ws\\bootstrap",
      "/ws\u0000",
    ]) {
      expect(upgradePathAllowsCompression(target), String(target)).toBe(false);
    }
  });
});
