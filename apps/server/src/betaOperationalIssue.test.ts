import { afterEach, expect, it, vi } from "vitest";
import { diagnosticIssueReason } from "@synara/shared/diagnosticIssue";
import { DESKTOP_DIAGNOSTIC_ISSUE_PREFIX } from "@synara/contracts";
import {
  SYNARA_DESKTOP_BUNDLE_ID_ENV,
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([SYNARA_PRODUCTION_BUNDLE_ID, "", SYNARA_BETA_BUNDLE_ID])(
  "emits only allowlisted fields from a Beta backend (%s)",
  async (bundleId) => {
    vi.stubEnv(SYNARA_DESKTOP_BUNDLE_ID_ENV, bundleId);
    vi.resetModules();
    const { reportBetaOperationalIssue } = await import("./betaOperationalIssue");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const issue = {
      code: "git.commit.failed" as const,
      reason: "output-limit" as const,
      privateText: "never emit",
    };
    reportBetaOperationalIssue(issue);
    const calls = write.mock.calls.slice();
    write.mockRestore();
    if (bundleId === SYNARA_BETA_BUNDLE_ID) {
      expect(calls).toEqual([
        [
          DESKTOP_DIAGNOSTIC_ISSUE_PREFIX +
            '{"code":"git.commit.failed","reason":"output-limit"}\n',
        ],
      ]);
    } else expect(calls).toEqual([]);
  },
);

it.each([
  ["gpg failed to sign the data: signing failed", "unknown"],
  ["error: commit signing failed", "unknown"],
  ["Please sign in to continue", "auth"],
  ["Sign-in required", "auth"],
  ["Signin required", "auth"],
] as const)(
  "classifies the emitted Git failure without confusing signing with login (%s)",
  async (message, reason) => {
    vi.stubEnv(SYNARA_DESKTOP_BUNDLE_ID_ENV, SYNARA_BETA_BUNDLE_ID);
    const { reportBetaOperationalIssue } = await import("./betaOperationalIssue");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    reportBetaOperationalIssue({
      code: "git.commit.failed",
      reason: diagnosticIssueReason(new Error(message)),
    });
    const emitted = write.mock.calls[0]?.[0];
    write.mockRestore();
    expect(emitted).toBe(
      DESKTOP_DIAGNOSTIC_ISSUE_PREFIX +
        JSON.stringify({ code: "git.commit.failed", reason }) +
        "\n",
    );
  },
);
