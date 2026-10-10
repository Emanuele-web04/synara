import { describe, expect, it } from "vitest";

import { computerBrowserEffect, computerBrowserFieldReadback } from "./computerBrowserEffect.ts";

const navigationArgs = {
  target_id: "bt-1",
  tab_id: "tab-1",
  url: "https://example.test/",
};
const navigationProof = {
  status: "ok",
  ...navigationArgs,
  verification: { scope: "navigation", method: "page_frame_tree", status: "confirmed" },
};

describe("computerBrowserEffect", () => {
  it.each([
    { effect: "confirmed", evidence: [{ kind: "value_readback" }] },
    { effect: "partial", route: "trusted_input", delivery: { delivered_count: 2 } },
    { status: "completed", download_id: "some-file", bytes: 200 },
  ])("does not promote generic browser dispatch evidence: %j", (structuredContent) => {
    expect(computerBrowserEffect("computer_browser_click", {}, { structuredContent })).toEqual({
      effect: "dispatched-unknown",
    });
  });

  it.each([
    {
      structuredContent: { status: "refused", refusal: { code: "browser_ref_stale" } },
      code: "browser_ref_stale",
    },
    {
      structuredContent: { status: "refused", code: "browser_requires_setup" },
      code: "browser_requires_setup",
    },
    { structuredContent: { effect: "refused", route: "dom" }, code: "browser_refused" },
  ])("recognizes legacy and current driver refusals: %j", ({ structuredContent, code }) => {
    expect(computerBrowserEffect("computer_browser_type", {}, { structuredContent })).toEqual({
      effect: "refused",
      code,
    });
    expect(
      computerBrowserEffect("computer_browser_type", {}, { structuredContent, isError: true }),
    ).toEqual({ effect: "refused", code });
  });

  it("accepts the native download proof only for the download operation", () => {
    for (const bytes of [0, 7_200]) {
      expect(
        computerBrowserEffect(
          "computer_browser_download",
          {},
          {
            structuredContent: { status: "completed", download_id: "opaque-file", bytes },
          },
        ),
      ).toEqual({ effect: "verified" });
    }
    for (const bytes of [-1, 0.5, Infinity, NaN, "7200", undefined]) {
      expect(
        computerBrowserEffect(
          "computer_browser_download",
          {},
          {
            structuredContent: { status: "completed", download_id: "opaque-file", bytes },
          },
        ),
      ).toEqual({ effect: "dispatched-unknown" });
    }
    expect(
      computerBrowserEffect(
        "computer_browser_download",
        {},
        {
          structuredContent: { status: "completed", bytes: 7200 },
        },
      ),
    ).toEqual({ effect: "dispatched-unknown" });
  });

  it("preserves a delivered prefix instead of reporting a safe-to-retry refusal", () => {
    expect(
      computerBrowserEffect(
        "computer_browser_type",
        {},
        {
          structuredContent: {
            status: "refused",
            refusal: { code: "browser_input_incomplete", detail: { delivered_chars: 2 } },
          },
        },
      ),
    ).toEqual({ effect: "dispatched-unknown" });
  });

  it("verifies only a matching navigation with explicit fresh native evidence", () => {
    expect(
      computerBrowserEffect("computer_browser_navigate", navigationArgs, {
        structuredContent: navigationProof,
      }),
    ).toEqual({ effect: "verified" });
    for (const key of ["target_id", "tab_id", "url"] as const) {
      expect(
        computerBrowserEffect("computer_browser_navigate", navigationArgs, {
          structuredContent: { ...navigationProof, [key]: "different" },
        }),
      ).toEqual({ effect: "dispatched-unknown" });
    }
    for (const verification of [
      undefined,
      {},
      { scope: "navigation", method: "page_frame_tree", status: "unconfirmed" },
      { scope: "navigation", method: "url_echo", status: "confirmed" },
      { scope: "field", method: "page_frame_tree", status: "confirmed" },
    ]) {
      expect(
        computerBrowserEffect("computer_browser_navigate", navigationArgs, {
          structuredContent: { ...navigationProof, verification },
        }),
      ).toEqual({ effect: "dispatched-unknown" });
    }
    expect(
      computerBrowserEffect("computer_browser_click", navigationArgs, {
        structuredContent: navigationProof,
      }),
    ).toEqual({ effect: "dispatched-unknown" });
  });

  it("never lets proof override a reported error", () => {
    expect(
      computerBrowserEffect("computer_browser_navigate", navigationArgs, {
        structuredContent: navigationProof,
        isError: true,
      }),
    ).toEqual({ effect: "error", code: "browser_error" });
  });

  it("keeps invalid or absent structured data unknown", () => {
    for (const structuredContent of [undefined, null, [], "completed", 1]) {
      expect(
        computerBrowserEffect("computer_browser_navigate", navigationArgs, { structuredContent }),
      ).toEqual({ effect: "dispatched-unknown" });
    }
  });
});

describe("computerBrowserFieldReadback", () => {
  const args = { text: "private value", replace: true, input_route: "dom_event" };
  const result = {
    structuredContent: {
      effect: "unverifiable",
      route: "dom",
      evidence: [{ kind: "value_readback" }],
    },
  };

  it("recognizes field evidence without promoting the application effect", () => {
    expect(computerBrowserFieldReadback("computer_browser_type", args, result)).toBe(true);
    expect(computerBrowserEffect("computer_browser_type", args, result)).toEqual({
      effect: "dispatched-unknown",
    });
  });

  it("does not treat field readback as proof for another browser tool", () => {
    expect(computerBrowserFieldReadback("computer_browser_click", args, result)).toBe(false);
  });

  it("requires the exact replacement route and actual value evidence", () => {
    expect(
      computerBrowserFieldReadback("computer_browser_type", { ...args, replace: false }, result),
    ).toBe(false);
    expect(
      computerBrowserFieldReadback(
        "computer_browser_type",
        { ...args, mode: "keystrokes" },
        result,
      ),
    ).toBe(false);
    expect(
      computerBrowserFieldReadback(
        "computer_browser_type",
        { ...args, input_route: "trusted" },
        result,
      ),
    ).toBe(false);
    expect(
      computerBrowserFieldReadback("computer_browser_type", args, { ...result, isError: true }),
    ).toBe(false);
    for (const evidence of [undefined, [], [{ kind: "window_change" }], [{ kind: "url_echo" }]]) {
      expect(
        computerBrowserFieldReadback("computer_browser_type", args, {
          structuredContent: { ...result.structuredContent, evidence },
        }),
      ).toBe(false);
    }
  });
});
