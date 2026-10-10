// FILE: panelResize.browser.ts
// Purpose: Browser-layout regression tests for panel resize composer probes.
// Layer: Web DOM behavior tests
// Depends on: panelResize, chatPaneScope

import { afterEach, describe, expect, it } from "vitest";

import { SINGLE_CHAT_PANE_SCOPE_ID, dockSidechatPaneScopeId } from "./chatPaneScope";
import { canComposerHandlePanelWidth } from "./panelResize";

interface MountedComposer {
  viewport: HTMLDivElement;
}

function mountComposer(input: {
  scopeId: string;
  widthPx: number;
  displayContentsWrapper?: boolean;
  rightActionsWidthPx?: number;
}): MountedComposer {
  const viewport = document.createElement("div");
  viewport.style.width = `${input.widthPx}px`;
  viewport.style.padding = "0";
  viewport.style.boxSizing = "border-box";

  const wrapper = document.createElement("div");
  if (input.displayContentsWrapper) {
    wrapper.style.display = "contents";
  }

  const form = document.createElement("form");
  form.dataset.chatComposerForm = "true";
  form.dataset.chatPaneScope = input.scopeId;
  form.style.display = "block";
  form.style.width = "100%";
  form.style.boxSizing = "border-box";

  const footer = document.createElement("div");
  footer.dataset.chatComposerFooter = "true";
  footer.style.display = "flex";
  footer.style.columnGap = "8px";

  const leftControls = document.createElement("div");
  leftControls.style.flex = "1 1 auto";
  leftControls.style.minWidth = "0";

  const rightActions = document.createElement("div");
  rightActions.dataset.chatComposerActions = "right";
  rightActions.style.width = `${input.rightActionsWidthPx ?? 48}px`;
  rightActions.style.height = "20px";
  rightActions.style.flex = `0 0 ${input.rightActionsWidthPx ?? 48}px`;

  footer.append(leftControls, rightActions);
  form.append(footer);
  wrapper.append(form);
  viewport.append(wrapper);
  document.body.append(viewport);

  return { viewport };
}

describe("canComposerHandlePanelWidth", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("measures through display: contents composer wrappers", () => {
    const composer = mountComposer({
      scopeId: SINGLE_CHAT_PANE_SCOPE_ID,
      widthPx: 520,
      displayContentsWrapper: true,
    });

    const accepted = canComposerHandlePanelWidth({
      nextWidth: 420,
      applyWidth: (width) => {
        composer.viewport.style.width = `${width}px`;
      },
      resetWidth: () => {
        composer.viewport.style.width = "520px";
      },
    });

    expect(accepted).toBe(true);
    expect(composer.viewport.style.width).toBe("520px");
  });

  it("defaults to the single-chat composer when dock panes mount sidechat composers first", () => {
    const sidechatComposer = mountComposer({
      scopeId: dockSidechatPaneScopeId("pane-1"),
      widthPx: 520,
      rightActionsWidthPx: 520,
    });
    const singleComposer = mountComposer({
      scopeId: SINGLE_CHAT_PANE_SCOPE_ID,
      widthPx: 520,
      rightActionsWidthPx: 48,
    });

    const accepted = canComposerHandlePanelWidth({
      nextWidth: 360,
      applyWidth: (width) => {
        sidechatComposer.viewport.style.width = `${width}px`;
        singleComposer.viewport.style.width = `${width}px`;
      },
      resetWidth: () => {
        sidechatComposer.viewport.style.width = "520px";
        singleComposer.viewport.style.width = "520px";
      },
    });

    expect(accepted).toBe(true);
    expect(sidechatComposer.viewport.style.width).toBe("520px");
    expect(singleComposer.viewport.style.width).toBe("520px");
  });
});
