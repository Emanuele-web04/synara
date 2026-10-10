import type { OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { deriveFastModeNotice } from "./fastModeState";

function fastModeActivity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: `activity-${JSON.stringify(payload)}`,
    kind: "fast-mode.state",
    tone: "info",
    summary: "Fast mode state reported",
    payload,
    turnId: null,
    createdAt: "2026-10-10T00:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

describe("deriveFastModeNotice", () => {
  it("stays silent without a report or while fast mode is serving", () => {
    expect(deriveFastModeNotice([])).toBeNull();
    expect(deriveFastModeNotice([fastModeActivity({ state: "on" })])).toBeNull();
  });

  it("explains why the account refused fast mode", () => {
    expect(
      deriveFastModeNotice([
        fastModeActivity({ state: "off", disabledReason: "extra_usage_disabled" }),
      ]),
    ).toEqual({
      kind: "blocked",
      label: "Fast unavailable",
      detail:
        "Fast mode is not active: usage credits are turned off for this Claude account. Requests run at standard speed.",
    });
    expect(
      deriveFastModeNotice([fastModeActivity({ state: "off", disabledReason: "something_new" })])
        ?.detail,
    ).toContain("Claude reported it as unavailable");
  });

  it("does not treat a session that never requested fast mode as blocked", () => {
    for (const disabledReason of ["sdk_opt_in_required", "preference", "pending", undefined]) {
      expect(deriveFastModeNotice([fastModeActivity({ state: "off", disabledReason })])).toBeNull();
    }
  });

  it("reports a cooldown and follows the latest report", () => {
    const blocked = fastModeActivity({ state: "off", disabledReason: "free" });
    expect(deriveFastModeNotice([blocked, fastModeActivity({ state: "cooldown" })])?.kind).toBe(
      "cooldown",
    );
    expect(deriveFastModeNotice([blocked, fastModeActivity({ state: "on" })])).toBeNull();
  });
});
