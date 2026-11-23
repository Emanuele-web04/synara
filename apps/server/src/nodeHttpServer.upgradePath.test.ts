// Compression eligibility is decided from the raw upgrade target before any
// routing happens, so it must agree with the router's matching semantics
// (find-my-way-ts: case-insensitive, duplicate slashes and trailing slashes
// ignored). A spelling the router sends to the pre-auth bootstrap route while
// this says "compressed" is a live zlib-amplification bypass, so the table
// below is the security boundary. The live-socket assertions in
// wsRpc.connectionLifecycle.test.ts cover the negotiation itself.

import { describe, expect, it } from "vitest";

import { WS_FEATURE_UNCOMPRESSED_QUERY } from "@synara/contracts";

import { upgradeOptsOutOfCompression, upgradePathAllowsCompression } from "./nodeHttpServer";

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
      // Invalid percent-encoding: decoding throws, so the raw target stands
      // and cannot match the feature route.
      "/ws/%zz",
      "/%C0%AFws",
      "/ws\\bootstrap",
      "/ws\u0000",
    ]) {
      expect(upgradePathAllowsCompression(target), String(target)).toBe(false);
    }
  });
});

describe("upgradeOptsOutOfCompression", () => {
  const flag = `${WS_FEATURE_UNCOMPRESSED_QUERY.name}=${WS_FEATURE_UNCOMPRESSED_QUERY.value}`;

  it("reads the declared opt-out from the query of any target form", () => {
    for (const target of [
      `/ws?${flag}`,
      `/ws?wsToken=abc&${flag}`,
      `/WS/?x=1&${flag}#fragment`,
      `http://host/ws?${flag}`,
    ]) {
      expect(upgradeOptsOutOfCompression(target), target).toBe(true);
    }
  });

  it("keeps compression without the exact flag", () => {
    for (const target of [
      undefined,
      "",
      "/ws",
      "/ws?wsToken=abc",
      `/ws?${WS_FEATURE_UNCOMPRESSED_QUERY.name}=0`,
      `/ws?${WS_FEATURE_UNCOMPRESSED_QUERY.name}=true`,
      `/ws?${WS_FEATURE_UNCOMPRESSED_QUERY.name}`,
      `/ws#${flag}`,
    ]) {
      expect(upgradeOptsOutOfCompression(target), String(target)).toBe(false);
    }
  });
});
