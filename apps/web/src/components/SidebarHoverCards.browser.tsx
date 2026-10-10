import "../index.css";

import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { computedColorAlpha, installGlassOverlayCutout } from "~/lib/glassOverlayCutout";

import {
  createProjectHoverCardAnchor,
  createThreadHoverCardAnchor,
} from "./sidebarHoverCardAnchors";
import {
  SIDEBAR_HOVER_CARD_POPUP_PROPS,
  SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME,
  SIDEBAR_HOVER_CARD_TRIGGER_PROPS,
} from "./sidebarHoverCardStyles";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./ui/preview-card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function HoverCards({
  kind,
  onOpen,
}: {
  kind: "thread" | "project";
  onOpen: (id: string) => void;
}) {
  const Card = kind === "thread" ? Tooltip : PreviewCard;
  const Trigger = kind === "thread" ? TooltipTrigger : PreviewCardTrigger;
  const Popup = kind === "thread" ? TooltipPopup : PreviewCardPopup;
  return (
    <div data-slot="sidebar-container" className="w-72 p-2">
      {["First", "Second"].map((id) => (
        <Card key={id} onOpenChange={(open) => open && onOpen(id)}>
          <Trigger
            {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
            render={
              <button
                type="button"
                className="mb-1 block h-9 w-full text-left"
                data-thread-hover-anchor={id}
                data-project-hover-anchor={id}
              />
            }
          >
            {id} row
          </Trigger>
          <Popup
            {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
            anchor={
              kind === "thread" ? createThreadHoverCardAnchor(id) : createProjectHoverCardAnchor(id)
            }
            className={SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME}
          >
            <button type="button" className="w-full p-4">
              {id} card action
            </button>
          </Popup>
        </Card>
      ))}
    </div>
  );
}

describe.each(["thread", "project"] as const)("sidebar %s hover cards", (kind) => {
  it.each(["sidebar", "window"])(
    "keeps the app's clipping stable while hovering in %s glass",
    async (scope) => {
      await page.viewport(1280, 800);
      const html = document.documentElement;
      const previousMaterial = html.dataset.windowMaterial;
      const previousScope = html.dataset.windowTranslucency;
      html.dataset.windowMaterial = "translucent";
      html.dataset.windowTranslucency = scope;
      const root = document.createElement("div");
      root.style.cssText = "position:fixed;inset:0";
      document.body.append(root);
      const dispose = installGlassOverlayCutout(root);
      const opened: string[] = [];
      const mounted = await render(<HoverCards kind={kind} onOpen={(id) => opened.push(id)} />, {
        container: root,
      });
      const clips: string[] = [];
      const observer = new MutationObserver(() => clips.push(root.style.clipPath));
      observer.observe(root, { attributes: true, attributeFilter: ["style"] });
      try {
        for (const name of ["First", "Second"]) {
          await page.getByRole("button", { name: `${name} row`, exact: true }).hover();
          const action = page.getByRole("button", { name: `${name} card action`, exact: true });
          await expect.element(action).toBeVisible();
          // Cover the fade and scale transition, including intermediate root clips.
          await new Promise((resolve) => window.setTimeout(resolve, 400));
          await action.hover();
          await expect.element(action).toBeVisible();
          const popup = action.element().closest<HTMLElement>(".app-popup-surface")!;
          expect(
            computedColorAlpha(getComputedStyle(popup).backgroundColor),
          ).toBeGreaterThanOrEqual(0.95);
          expect(getComputedStyle(popup, "::before").backdropFilter).toBe("none");
          expect(root.style.clipPath).toBe("");
          expect(clips.filter(Boolean)).toEqual([]);
        }
        expect(opened).toEqual(["First", "Second"]);
      } finally {
        observer.disconnect();
        await mounted.unmount();
        dispose();
        root.remove();
        if (previousMaterial === undefined) delete html.dataset.windowMaterial;
        else html.dataset.windowMaterial = previousMaterial;
        if (previousScope === undefined) delete html.dataset.windowTranslucency;
        else html.dataset.windowTranslucency = previousScope;
      }
    },
  );
});
