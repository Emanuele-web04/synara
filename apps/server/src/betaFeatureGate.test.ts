// FILE: betaFeatureGate.test.ts
// Purpose: Verify the server host's shared Beta-only feature policy.
import { afterEach, expect, it, vi } from "vitest";
import {
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_DESKTOP_BUNDLE_ID_ENV,
  SYNARA_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";
import { ACCOUNT_INBOX_BETA_FEATURE } from "@synara/shared/betaFeatures";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  [SYNARA_PRODUCTION_BUNDLE_ID, true],
  [SYNARA_BETA_BUNDLE_ID, true],
] as const)("allows saved Inbox recaps on the host bundle (%s)", async (bundleId, enabled) => {
  vi.stubEnv(SYNARA_DESKTOP_BUNDLE_ID_ENV, bundleId);
  vi.resetModules();
  const { isServerBetaFeatureEnabled } = await import("./betaFeatureGate");
  expect(isServerBetaFeatureEnabled(ACCOUNT_INBOX_BETA_FEATURE)).toBe(enabled);
});
