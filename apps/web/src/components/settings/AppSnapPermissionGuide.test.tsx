// FILE: AppSnapPermissionGuide.test.tsx
// Purpose: The guide must name the page the running macOS shows, and ask for
//          the list's own control instead of a drag.
// Layer: Component rendering tests

import type { DesktopAppSnapSettingsPane } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppSnapPermissionGuide } from "./AppSnapPermissionGuide";

function renderGuide(pane: DesktopAppSnapSettingsPane, osVersion: string | null): string {
  return renderToStaticMarkup(
    <AppSnapPermissionGuide
      pane={pane}
      appDisplayName="Synara"
      osVersion={osVersion}
      waiting
      onOpenSettings={() => undefined}
      onRestart={() => undefined}
    />,
  );
}

describe("AppSnapPermissionGuide", () => {
  it("names the page 27.0 shows, and the one it replaced before that", () => {
    expect(renderGuide("accessibility", "27.0.1")).toContain(
      "Open Device Control and Data Access settings",
    );
    expect(renderGuide("accessibility", "26.5.1")).toContain("Open Accessibility settings");
  });

  it("names the second page where 27.3 splits the grant, and only there", () => {
    expect(renderGuide("accessibility", "27.0.1")).not.toContain(
      "System & App Protection Override",
    );
    expect(renderGuide("accessibility", "27.2.9")).not.toContain(
      "System & App Protection Override",
    );
    // Static markup escapes the ampersand in the page's own title.
    expect(renderGuide("accessibility", "27.3.1")).toContain(
      "look for it under System &amp; App Protection Override",
    );
  });

  it("asks for the list's own add control, never a drag", () => {
    expect(renderGuide("accessibility", "27.0.1")).toContain(
      "press Add and choose it from Applications",
    );
  });
});
