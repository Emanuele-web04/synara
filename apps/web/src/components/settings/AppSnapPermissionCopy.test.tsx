// FILE: AppSnapPermissionCopy.test.tsx
// Purpose: Guards the web permissions copy slice — pane labels stay in sync and
//          the guide never claims a live system dialog is open.
// Layer: Component rendering tests (pure, no TCC/Electron/timers).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { COMPUTER_PERMISSION_LABELS } from "@synara/shared/computerGrants";
import { AppSnapPermissionGuide } from "./AppSnapPermissionGuide";
import { COMPUTER_PERMISSION_PANES } from "./AppSnapPermissionSection";

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
  it("keeps COMPUTER_PANES titles equal to LABELS", () => {
    const titles = COMPUTER_PERMISSION_PANES.map((entry) => entry.title).sort();
    const labels = Object.values(COMPUTER_PERMISSION_LABELS).sort();
    expect(titles).toEqual(labels);
  });

  it("walks through System Settings without claiming a live dialog", () => {
    for (const pane of ["accessibility", "input-monitoring", "screen-recording"] as const) {
      const markup = renderGuide(pane);
      expect(markup).toContain("Watching for the change");
      expect(markup).toContain("Restart");
      expect(markup).not.toContain("macOS is asking");
      expect(markup).not.toContain("live dialog");
      expect(markup).not.toContain("dialog is open");
    }
  });

  it("reuses drag or add instructions and makes authentication and stale-build recovery conditional", () => {
    for (const pane of ["accessibility", "input-monitoring", "screen-recording"] as const) {
      const markup = renderGuide(pane);
      expect(markup).toContain("drag the app from the floating guide");
      expect(markup).toContain("use + to choose this installed copy");
      expect(markup).toContain("If this copy of Synara is already listed, turn it on.");
      expect(markup).toContain("If macOS asks you to quit and reopen");
      expect(markup).toContain("Remove this app from the list and add this copy again.");
      expect(markup).not.toContain("Entries cannot be dragged");
      expect(markup).not.toContain("No dialog will appear");
      expect(markup).not.toContain("Restarting the app clears");
    }
  });
});
