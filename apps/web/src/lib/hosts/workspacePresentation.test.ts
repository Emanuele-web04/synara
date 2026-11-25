import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  "inherits controller presentation without exposing native APIs (desktop=%s)",
  async (desktop) => {
    vi.resetModules();
    const parent = { innerWidth: 1100 };
    const pane = {
      innerWidth: 700,
      parent,
      frameElement: { synaraWorkspace: { controller: { desktop } } },
    };
    vi.stubGlobal("window", pane);
    const presentation = await import("./workspacePresentation");
    expect(presentation.isDesktopPresentation).toBe(desktop);
    expect(presentation.presentationWindow()?.innerWidth).toBe(1100);
    expect((await import("../../env")).isElectron).toBe(false);
    expect("nativeApi" in pane).toBe(false);
  },
);

it("keeps ordinary browser viewports local even when embedded", async () => {
  vi.resetModules();
  vi.stubGlobal("window", { innerWidth: 600, parent: { innerWidth: 1100 }, frameElement: {} });
  const presentation = await import("./workspacePresentation");
  expect(presentation.isDesktopPresentation).toBe(false);
  expect(presentation.presentationWindow()?.innerWidth).toBe(600);
});
