import { describe, expect, it } from "vitest";

import { getFormatLocale, i18n, t } from "./index";

describe("bundled translations", () => {
  it("reads the shipped English catalogs", () => {
    expect(i18n.language).toBe("en");
    expect(t("workspace:toast_settings")).toBe("Settings");
  });

  it("preserves interpolated data and uses the shipped English plural forms", () => {
    expect(t("common:open", { title: "<script>Settings</script>" })).toBe(
      "Open <script>Settings</script>",
    );
    expect(t("common:open", { title: "项目名称" })).toBe("Open 项目名称");
    expect(t("chat:backgroundTaskCount", { count: 1 })).toBe("1 background task");
    expect(t("chat:backgroundTaskCount", { count: 2 })).toBe("2 background tasks");
  });

  it("formats dates and numbers using the system locale", () => {
    expect(getFormatLocale()).toBe(new Intl.DateTimeFormat().resolvedOptions().locale);
  });

  it("preserves literal URLs, paths, names, and already translated copy passed through metadata", () => {
    for (const value of [
      "https://api2.cursor.sh",
      "C:\\Users\\name\\repo",
      "Edit: name",
      "provider:model-name",
      "设置",
      "Settings",
      "workspace:名字",
    ]) {
      expect(t(value)).toBe(value);
    }
    expect(t("workspace:toast_settings")).toBe("Settings");
  });
});

describe("original English counts", () => {
  it("chooses singular and plural wording by count", () => {
    expect(t("workspace:moveSelectedProjects", { count: 1 })).toBe("Move 1 project");
    expect(t("workspace:moveSelectedProjects", { count: 3 })).toBe("Move 3 projects");
    expect(t("settings:skillsEnabledOf", { enabled: 1, total: 1, count: 1 })).toBe(
      "1 of 1 skill enabled",
    );
    expect(t("settings:skillsEnabledOf", { enabled: 2, total: 5, count: 5 })).toBe(
      "2 of 5 skills enabled",
    );
    expect(t("common:updatesAvailableForAndMoreProviders", { provider: "Codex", count: 2 })).toBe(
      "Codex and 2 more providers have newer versions available.",
    );
    expect(
      t("git:projectRepositoriesUnavailableHealthyRepositoriesAreStillShown", { count: 1 }),
    ).toBe("1 project repository was unavailable. Healthy repositories are still shown.");
    expect(t("git:openItems")).toBe("Open");
  });
});
