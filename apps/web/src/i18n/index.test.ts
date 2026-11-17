import { describe, expect, it } from "vitest";

import { t } from "./index";

describe("bundled translations", () => {
  it("preserves interpolated data and uses the shipped English plural forms", () => {
    expect(t("common:open", { title: "<script>Settings</script>" })).toBe(
      "Open <script>Settings</script>",
    );
    expect(t("common:open", { title: "项目名称" })).toBe("Open 项目名称");
    expect(t("chat:backgroundTaskCount", { count: 1 })).toBe("1 background task");
    expect(t("chat:backgroundTaskCount", { count: 2 })).toBe("2 background tasks");
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
