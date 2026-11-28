import { describe, expect, it } from "vitest";

import { resolveAppSnapSettingsPaneUrl } from "./appSnapIpc";

describe("resolveAppSnapSettingsPaneUrl", () => {
  it("opens the parent settings page rather than the old accessibility pane from 27.3", () => {
    expect(resolveAppSnapSettingsPaneUrl("accessibility", "27.3.1")).toBe(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
    );
    expect(resolveAppSnapSettingsPaneUrl("accessibility", "27.2")).toContain(
      "?Privacy_Accessibility",
    );
  });

  it("keeps direct links for the other permissions", () => {
    expect(resolveAppSnapSettingsPaneUrl("input-monitoring", "27.3.1")).toContain(
      "?Privacy_ListenEvent",
    );
    expect(resolveAppSnapSettingsPaneUrl("screen-recording", "27.3.1")).toContain(
      "?Privacy_ScreenCapture",
    );
  });
});
