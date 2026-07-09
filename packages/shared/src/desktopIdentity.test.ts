import { describe, expect, it } from "vitest";

import {
  SYNARA_DESKTOP_ENTRY_URL,
  SYNARA_DESKTOP_ORIGIN,
  SYNARA_DESKTOP_UPDATE_CHANNEL,
  SYNARA_DEVELOPMENT_BUNDLE_ID,
  SYNARA_PRODUCTION_BUNDLE_ID,
  synaraBundleId,
} from "./desktopIdentity";

describe("desktopIdentity", () => {
  it("uses the exact canonical production and development bundle IDs", () => {
    expect(SYNARA_PRODUCTION_BUNDLE_ID).toBe("com.emanueledipietro.synara");
    expect(SYNARA_DEVELOPMENT_BUNDLE_ID).toBe("com.emanueledipietro.synara.dev");
    expect(synaraBundleId(false)).toBe(SYNARA_PRODUCTION_BUNDLE_ID);
    expect(synaraBundleId(true)).toBe(SYNARA_DEVELOPMENT_BUNDLE_ID);
  });

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(SYNARA_DESKTOP_ORIGIN).toBe("synara://app");
    expect(SYNARA_DESKTOP_ENTRY_URL).toBe("synara://app/index.html");
  });

  it("uses the isolated Synara desktop update channel", () => {
    expect(SYNARA_DESKTOP_UPDATE_CHANNEL).toBe("synara");
  });
});
