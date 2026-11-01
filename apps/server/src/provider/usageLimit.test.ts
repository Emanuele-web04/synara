import { describe, expect, it } from "vitest";
import {
  claudeUsageLimitWindows,
  codexErrorCode,
  codexUsageLimitWindows,
  isCodexUsageLimitError,
  usageLimitResetAt,
} from "./usageLimit.ts";

const NOW = Date.parse("2026-10-31T10:00:00.000Z");
const HOUR = NOW / 1_000 + 3_600;
const WEEK = NOW / 1_000 + 604_800;

// Real SDK/app-server envelopes are the boundary: display usage alone is insufficient.
describe("provider quota evidence", () => {
  it("waits for every rejected Claude window and keeps the latest deadline", () => {
    let evidence = claudeUsageLimitWindows(
      undefined,
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: HOUR },
      },
      NOW,
    );
    evidence = claudeUsageLimitWindows(
      evidence,
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "seven_day_sonnet", resetsAt: WEEK },
      },
      NOW,
    );
    expect(usageLimitResetAt(evidence, NOW)).toBe(new Date(WEEK * 1_000).toISOString());
    evidence = claudeUsageLimitWindows(
      evidence,
      {
        rate_limit_info: { status: "rejected", rateLimitType: "seven_day_opus" },
      },
      NOW,
    );
    expect(usageLimitResetAt(evidence, NOW)).toBeNull();
  });

  it.each([
    { status: "allowed" },
    { status: "allowed_warning" },
    { status: "rejected", overageStatus: "allowed", overageEnabled: true },
  ])("clears an old Claude rejection after $status / $overageStatus", (info) => {
    const rejected = claudeUsageLimitWindows(
      undefined,
      {
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: HOUR },
      },
      NOW,
    );
    expect(
      usageLimitResetAt(claudeUsageLimitWindows(rejected, { rate_limit_info: info }, NOW), NOW),
    ).toBeNull();
  });

  it.each(["allowed", "allowed_warning"])(
    "clears only a named Claude %s window while a weekly limit remains",
    (status) => {
      let evidence = claudeUsageLimitWindows(
        undefined,
        {
          rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: HOUR },
        },
        NOW,
      );
      evidence = claudeUsageLimitWindows(
        evidence,
        {
          rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: WEEK },
        },
        NOW,
      );
      evidence = claudeUsageLimitWindows(
        evidence,
        {
          rate_limit_info: { status, rateLimitType: "five_hour" },
        },
        NOW,
      );
      expect(usageLimitResetAt(evidence, NOW)).toBe(new Date(WEEK * 1_000).toISOString());
      expect(
        usageLimitResetAt(
          claudeUsageLimitWindows(
            evidence,
            {
              rate_limit_info: { status: "allowed", rateLimitType: "seven_day" },
            },
            NOW,
          ),
          NOW,
        ),
      ).toBeNull();
    },
  );

  it.each([{ overageStatus: "allowed" }, { isUsingOverage: true }, { overageInUse: true }])(
    "honors confirmed account-wide Claude overage bypass %j",
    (overage) => {
      const evidence = claudeUsageLimitWindows(
        undefined,
        {
          rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: WEEK },
        },
        NOW,
      );
      expect(
        usageLimitResetAt(
          claudeUsageLimitWindows(
            evidence,
            {
              rate_limit_info: { status: "rejected", ...overage },
            },
            NOW,
          ),
          NOW,
        ),
      ).toBeNull();
    },
  );

  it("keeps permanent credits and stale or malformed reset times manual", () => {
    for (const info of [
      { errorCode: "credits_required", resetsAt: HOUR },
      { rateLimitType: "overage", overageDisabledReason: "out_of_credits", resetsAt: HOUR },
      { resetsAt: NOW / 1_000 - 1 },
      { resetsAt: "tomorrow" },
      { resetsAt: Number.POSITIVE_INFINITY },
    ]) {
      const evidence = claudeUsageLimitWindows(
        undefined,
        {
          rate_limit_info: { status: "rejected", ...info },
        },
        NOW,
      );
      expect(usageLimitResetAt(evidence, NOW)).toBeNull();
    }
  });

  it("reads both exhausted Codex windows without borrowing another limit bucket", () => {
    const snapshot = {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 100, resetsAt: HOUR },
        secondary: { usedPercent: 100, resetsAt: WEEK },
        credits: { hasCredits: false, unlimited: false },
      },
    };
    expect(usageLimitResetAt(codexUsageLimitWindows(snapshot, NOW), NOW)).toBe(
      new Date(WEEK * 1_000).toISOString(),
    );
    expect(
      codexUsageLimitWindows({ rateLimitsByLimitId: { other: snapshot.rateLimits } }, NOW),
    ).toBeUndefined();
    expect(
      codexUsageLimitWindows({ rateLimits: { ...snapshot.rateLimits, limitId: "other" } }, NOW),
    ).toBeUndefined();
    expect(
      usageLimitResetAt(
        codexUsageLimitWindows(
          {
            rateLimits: {
              ...snapshot.rateLimits,
              secondary: { usedPercent: 100 },
            },
          },
          NOW,
        ),
        NOW,
      ),
    ).toBeNull();
  });

  it("merges canonical Codex window patches and clears only explicit replacement windows", () => {
    let evidence = codexUsageLimitWindows(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 100, resetsAt: HOUR },
          secondary: { usedPercent: 100, resetsAt: WEEK },
        },
      },
      NOW,
    );
    evidence = codexUsageLimitWindows(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 20, resetsAt: HOUR },
        },
      },
      NOW,
      evidence,
    );
    expect(usageLimitResetAt(evidence, NOW)).toBe(new Date(WEEK * 1_000).toISOString());
    expect(
      codexUsageLimitWindows(
        { rateLimitsByLimitId: { unrelated: { primary: { usedPercent: 0 } } } },
        NOW,
        evidence,
      ),
    ).toBe(evidence);
    evidence = codexUsageLimitWindows(
      { rateLimits: { primary: { usedPercent: 100, resetsAt: HOUR }, secondary: null } },
      NOW,
      evidence,
    );
    expect(usageLimitResetAt(evidence, NOW)).toBe(new Date(HOUR * 1_000).toISOString());
    evidence = codexUsageLimitWindows(
      { rateLimits: { primary: { resetsAt: null } } },
      NOW,
      evidence,
    );
    expect(usageLimitResetAt(evidence, NOW)).toBeNull();
    expect(codexUsageLimitWindows({ rateLimits: null }, NOW, evidence)).toBeUndefined();
  });

  it("preserves Codex overage permission until a later patch explicitly removes it", () => {
    let evidence = codexUsageLimitWindows(
      {
        rateLimits: {
          primary: { usedPercent: 100, resetsAt: HOUR },
          credits: { hasCredits: true, unlimited: true },
        },
      },
      NOW,
    );
    evidence = codexUsageLimitWindows(
      {
        rateLimits: {
          secondary: { usedPercent: 100, resetsAt: WEEK },
          credits: { hasCredits: false },
        },
      },
      NOW,
      evidence,
    );
    expect(usageLimitResetAt(evidence, NOW)).toBeNull();
    evidence = codexUsageLimitWindows(
      { rateLimits: { credits: { unlimited: false } } },
      NOW,
      evidence,
    );
    expect(usageLimitResetAt(evidence, NOW)).toBe(new Date(WEEK * 1_000).toISOString());
  });

  it("does not treat available Codex credits or non-exhausted windows as a quota deadline", () => {
    for (const rateLimits of [
      { primary: { usedPercent: 10, resetsAt: HOUR } },
      { primary: { usedPercent: 100, resetsAt: HOUR }, credits: { hasCredits: true } },
      { primary: { usedPercent: 100, resetsAt: HOUR }, credits: { unlimited: true } },
    ]) {
      expect(usageLimitResetAt(codexUsageLimitWindows({ rateLimits }, NOW), NOW)).toBeNull();
    }
  });

  it("recognizes structured Codex quota errors and rejects overload and other HTTP statuses", () => {
    for (const info of [
      "usageLimitExceeded",
      "rateLimitExceeded",
      { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
    ]) {
      const error = { codexErrorInfo: info };
      expect(isCodexUsageLimitError(codexErrorCode(error), error)).toBe(true);
    }
    for (const info of [
      "usageLimitReached",
      "contextWindowExceeded",
      "serverOverloaded",
      { responseTooManyFailedAttempts: { httpStatusCode: 503 } },
      { httpConnectionFailed: { httpStatusCode: 429 } },
    ]) {
      const error = { codexErrorInfo: info };
      expect(isCodexUsageLimitError(codexErrorCode(error), error)).toBe(false);
    }
    expect(codexErrorCode({ codex_error_info: { serverOverloaded: {} } })).toBe(
      "server_overloaded",
    );
  });
});
