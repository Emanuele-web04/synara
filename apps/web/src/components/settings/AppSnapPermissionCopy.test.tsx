// FILE: AppSnapPermissionCopy.test.tsx
// Purpose: Guards the web permissions copy slice — pane labels stay in sync and
//          the guide never claims a live system dialog is open.
// Layer: Component rendering tests (pure, no TCC/Electron/timers).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppSnapPermissionGuide } from "./AppSnapPermissionGuide";
import { setLanguagePreference } from "~/i18n";

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function renderGuide(pane: Parameters<typeof AppSnapPermissionGuide>[0]["pane"]) {
  return renderToStaticMarkup(
    <AppSnapPermissionGuide
      pane={pane}
      appDisplayName="Synara"
      waiting
      onOpenSettings={() => undefined}
      onRestart={() => undefined}
    />,
  );
}

describe("AppSnap permission copy", () => {
  it.each([
    [
      "en",
      [
        "Open Accessibility settings",
        "Open Input Monitoring settings",
        "Open Screen Recording settings",
      ],
    ],
    ["zh-CN", ["打开 辅助功能 设置", "打开 输入监控 设置", "打开 屏幕录制 设置"]],
  ] as const)(
    "walks through localized System Settings without claiming a live dialog (%s)",
    (language, labels) => {
      setLanguagePreference(language);
      try {
        for (const [index, pane] of (
          ["accessibility", "input-monitoring", "screen-recording"] as const
        ).entries()) {
          const markup = renderGuide(pane);
          expect(markup).toContain(labels[index]);
          if (language === "en") {
            expect(markup).toContain("Watching for the change");
            expect(markup).toContain("Restart");
            expect(markup).toContain("If this copy of Synara is already listed");
            expect(markup).toContain("Complete any macOS authentication");
          } else {
            expect(markup).toContain("如果列表中已显示当前 Synara 副本");
            expect(markup).toContain("完成任何 macOS 身份验证");
          }
          expect(markup).not.toContain("settings:");
          expect(markup).not.toContain("macOS is asking");
          expect(markup).not.toContain("live dialog");
          expect(markup).not.toContain("dialog is open");
        }
      } finally {
        setLanguagePreference("en");
      }
    },
  );
});
