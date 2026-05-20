import { describe, expect, it } from "vitest";

import {
  normalizeHermesModelSlug,
  resolveHermesAutoApprovedOption,
  resolveHermesPermissionOutcome,
  shouldSetHermesModel,
} from "./HermesAcpSupport.ts";

describe("HermesAcpSupport", () => {
  it("maps approval decisions to Hermes ACP option kinds", () => {
    const options = [
      { kind: "allow_once", optionId: "once" },
      { kind: "allow_session", optionId: "session" },
      { kind: "allow_always", optionId: "always" },
      { kind: "reject_once", optionId: "reject" },
    ] as const;

    expect(resolveHermesPermissionOutcome("accept", options)).toBe("once");
    expect(resolveHermesPermissionOutcome("acceptForSession", options)).toBe("session");
    expect(resolveHermesPermissionOutcome("decline", options)).toBe("reject");
    expect(resolveHermesPermissionOutcome("cancel", options)).toBeUndefined();
  });

  it("auto-approves full-access prompts when an allow option exists", () => {
    const request = {
      options: [
        { kind: "allow_session", optionId: "session" },
        { kind: "allow_once", optionId: "once" },
      ],
    } as never;

    expect(resolveHermesAutoApprovedOption(request, "full-access")).toBe("session");
    expect(resolveHermesAutoApprovedOption(request, "approval-required")).toBeUndefined();
  });

  it("normalizes Hermes model slugs and placeholder ids", () => {
    expect(shouldSetHermesModel("hermes-agent")).toBe(false);
    expect(shouldSetHermesModel("opencode-go:deepseek-v4-flash")).toBe(true);
    expect(normalizeHermesModelSlug(" opencode-go:slug ")).toBe("opencode-go:slug");
  });
});
