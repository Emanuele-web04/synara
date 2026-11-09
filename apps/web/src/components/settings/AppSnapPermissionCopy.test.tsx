// FILE: AppSnapPermissionCopy.test.tsx
// Purpose: Guards the web permissions copy slice — pane labels stay in sync and
//          the guide never claims a live system dialog is open.
// Layer: Component rendering tests (pure, no TCC/Electron/timers).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppSnapPermissionGuide } from "./AppSnapPermissionGuide";

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
  it("walks through System Settings without claiming a live dialog", () => {
    const labels = [
      "Open Accessibility settings",
      "Open Input Monitoring settings",
      "Open Screen Recording settings",
    ];
    for (const [index, pane] of (
      ["accessibility", "input-monitoring", "screen-recording"] as const
    ).entries()) {
      const markup = renderGuide(pane);
      expect(markup).toContain(labels[index]);
      expect(markup).toContain("Watching for the change");
      expect(markup).toContain("Restart");
      expect(markup).toContain("If this copy of Synara is already listed");
      expect(markup).toContain("Complete any macOS authentication");
      expect(markup).not.toContain("settings:");
      expect(markup).not.toContain("macOS is asking");
      expect(markup).not.toContain("live dialog");
      expect(markup).not.toContain("dialog is open");
    }
  });
});
