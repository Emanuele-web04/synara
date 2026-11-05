import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_PRODUCTION_BUNDLE_ID,
  SYNARA_REMOTE_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";
import {
  accountProfileSyncUnavailableReason,
  requireAccountProfileSync,
} from "./remoteFeaturePolicy";

afterEach(() => vi.unstubAllEnvs());

describe("account profile activation", () => {
  it("enables the dedicated Remote app without operator setup but honors an explicit opt-out", () => {
    vi.stubEnv("SYNARA_DESKTOP_BUNDLE_ID", SYNARA_REMOTE_BUNDLE_ID);
    vi.stubEnv("SYNARA_ACCOUNT_PROFILE_SYNC", undefined);
    expect(requireAccountProfileSync).not.toThrow();
    vi.stubEnv("SYNARA_ACCOUNT_PROFILE_SYNC", "0");
    expect(requireAccountProfileSync).toThrow("profile sync is unavailable");
  });
  it("requires an explicit opt-in, including on Beta", () => {
    vi.stubEnv("SYNARA_DESKTOP_BUNDLE_ID", SYNARA_BETA_BUNDLE_ID);
    vi.stubEnv("SYNARA_ACCOUNT_PROFILE_SYNC", undefined);
    expect(accountProfileSyncUnavailableReason()).toContain("SYNARA_ACCOUNT_PROFILE_SYNC=1");
    expect(requireAccountProfileSync).toThrow("profile sync is unavailable");
    vi.stubEnv("SYNARA_ACCOUNT_PROFILE_SYNC", "1");
    expect(accountProfileSyncUnavailableReason()).toBeUndefined();
    expect(requireAccountProfileSync).not.toThrow();
  });

  it("refuses Stable even with an opt-in and persisted account state", () => {
    vi.stubEnv("SYNARA_DESKTOP_BUNDLE_ID", SYNARA_PRODUCTION_BUNDLE_ID);
    vi.stubEnv("SYNARA_ACCOUNT_PROFILE_SYNC", "1");
    expect(requireAccountProfileSync).toThrow("unavailable in Stable");
  });
});
