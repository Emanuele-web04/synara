import { describe, expect, it } from "vitest";

import {
  availabilityFromProbe,
  describeBrokenCapabilities,
  parseHelperProbe,
} from "./helperCapabilities.ts";

/** A probe payload with every capability healthy. */
const healthyProbe = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ok: true,
    protocolVersion: 1,
    capabilities: {
      framebuffer: "ok",
      hid: "ok",
      accessibility: "ok",
      encoder: "ok",
    },
    toolchain: { xcodeVersion: "26.2", xcodeBuild: "17C52", macOS: "Version 26.3" },
    ...overrides,
  });

describe("parseHelperProbe", () => {
  it("reads every capability and the toolchain from a healthy probe", () => {
    const probe = parseHelperProbe(healthyProbe());

    expect(probe.ok).toBe(true);
    expect(probe.capabilities.map((capability) => capability.id)).toEqual([
      "framebuffer",
      "hid",
      "accessibility",
      "encoder",
    ]);
    expect(probe.capabilities.every((capability) => capability.ok)).toBe(true);
    expect(probe.toolchain).toEqual({
      xcodeVersion: "26.2",
      xcodeBuild: "17C52",
      macOS: "Version 26.3",
    });
  });

  it("captures the missing symbol for a broken capability", () => {
    const probe = parseHelperProbe(
      healthyProbe({
        ok: false,
        capabilities: {
          framebuffer: "ok",
          hid: "ok",
          accessibility: { missingSymbol: "AXPTranslator", purpose: "translates the tree" },
          encoder: "ok",
        },
      }),
    );

    expect(probe.ok).toBe(false);
    const accessibility = probe.capabilities.find((entry) => entry.id === "accessibility");
    expect(accessibility).toMatchObject({ ok: false, missingSymbol: "AXPTranslator" });
    // The others are untouched: that separation is the whole point.
    expect(probe.capabilities.filter((entry) => entry.ok)).toHaveLength(3);
  });

  it("treats an unreported capability as broken rather than assuming it works", () => {
    const probe = parseHelperProbe(
      JSON.stringify({ ok: true, capabilities: { framebuffer: "ok", hid: "ok" } }),
    );

    // An older helper genuinely cannot provide what it never measured; claiming
    // otherwise would surface as a mystery failure at the point of use.
    expect(probe.capabilities.find((entry) => entry.id === "accessibility")?.ok).toBe(false);
    expect(probe.ok).toBe(false);
  });

  it("degrades rather than throwing on unreadable output", () => {
    const probe = parseHelperProbe("not json at all");

    expect(probe.ok).toBe(false);
    expect(probe.capabilities).toHaveLength(4);
    expect(probe.capabilities.every((capability) => !capability.ok)).toBe(true);
  });
});

describe("availabilityFromProbe", () => {
  it("maps a total failure to helper-unavailable", () => {
    const availability = availabilityFromProbe(
      parseHelperProbe(
        healthyProbe({
          ok: false,
          capabilities: {
            framebuffer: { missingSymbol: "SimServiceContext" },
            hid: { missingSymbol: "IndigoHIDMessageForButton" },
            accessibility: { missingSymbol: "AXPTranslator" },
            encoder: { error: "no session" },
          },
        }),
      ),
    );

    // Nothing works, so this is not "partly usable" — it is a broken helper.
    expect(availability.kind).toBe("helper-unavailable");
  });

  it("reports a framework load failure as helper-unavailable, not degraded", () => {
    const availability = availabilityFromProbe(
      parseHelperProbe(JSON.stringify({ ok: false, error: "CoreSimulator would not load" })),
    );

    expect(availability).toEqual({
      kind: "helper-unavailable",
      message: "CoreSimulator would not load",
    });
  });

  it("stays available when the helper predates capability reporting", () => {
    const availability = availabilityFromProbe(parseHelperProbe(JSON.stringify({ ok: true })));

    expect(availability).toEqual({ kind: "available" });
  });
});

describe("capability failure messages", () => {
  it("joins several broken capabilities into one phrase", () => {
    const summary = describeBrokenCapabilities(
      [
        { id: "accessibility", ok: false },
        { id: "hid", ok: false },
      ],
      { xcodeVersion: "26.3" },
    );

    expect(summary).toBe(
      "accessibility inspection and touch and keyboard input unavailable with Xcode 26.3",
    );
  });
});
