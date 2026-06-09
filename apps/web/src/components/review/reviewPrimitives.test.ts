import { describe, expect, it } from "vitest";

import { checksPill, prStatePill, reviewDecisionPill, severityPill } from "./reviewPrimitives";

describe("reviewDecisionPill", () => {
  it("returns null for empty decision", () => {
    expect(reviewDecisionPill(null)).toBeNull();
    expect(reviewDecisionPill("")).toBeNull();
  });

  it("maps known decisions to tones", () => {
    expect(reviewDecisionPill("APPROVED")).toEqual({ label: "Approved", tone: "success" });
    expect(reviewDecisionPill("CHANGES_REQUESTED")).toEqual({
      label: "Changes requested",
      tone: "warning",
    });
    expect(reviewDecisionPill("REVIEW_REQUIRED")).toEqual({
      label: "Review required",
      tone: "muted",
    });
  });

  it("title-cases unknown decisions as muted", () => {
    expect(reviewDecisionPill("SOME_OTHER_STATE")).toEqual({
      label: "Some Other State",
      tone: "muted",
    });
  });
});

describe("checksPill", () => {
  it("maps each status to a tone, omitting none", () => {
    expect(checksPill("passing")).toEqual({ label: "Checks", tone: "success" });
    expect(checksPill("failing")).toEqual({ label: "Checks", tone: "danger" });
    expect(checksPill("pending")).toEqual({ label: "Checks", tone: "warning" });
    expect(checksPill("none")).toBeNull();
  });
});

describe("prStatePill", () => {
  it("maps each state to a tone", () => {
    expect(prStatePill("open")).toEqual({ label: "Open", tone: "success" });
    expect(prStatePill("merged")).toEqual({ label: "Merged", tone: "info" });
    expect(prStatePill("closed")).toEqual({ label: "Closed", tone: "danger" });
  });
});

describe("severityPill", () => {
  it("maps each severity to a tone", () => {
    expect(severityPill("blocker")).toEqual({ label: "Blocker", tone: "danger" });
    expect(severityPill("major")).toEqual({ label: "Major", tone: "warning" });
    expect(severityPill("minor")).toEqual({ label: "Minor", tone: "info" });
    expect(severityPill("nit")).toEqual({ label: "Nit", tone: "muted" });
  });
});
