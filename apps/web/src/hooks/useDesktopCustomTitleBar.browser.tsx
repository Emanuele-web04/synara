import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useDesktopCustomTitleBarState } from "./useDesktopCustomTitleBar";

afterEach(() => vi.restoreAllMocks());

function TitleBarState() {
  const state = useDesktopCustomTitleBarState();
  return <output aria-label="Title bar">{state.active ? "custom" : "native"}</output>;
}

it("uses the controller's actual title bar state without a native bridge in the workspace", async () => {
  const frame = Object.assign(document.createElement("iframe"), {
    synaraWorkspace: {
      controller: {
        presentation: {
          readCustomTitleBarState: async () => ({
            supported: true,
            preference: true,
            active: true,
            restartRequired: false,
          }),
        },
      },
    },
  });
  vi.spyOn(window, "frameElement", "get").mockReturnValue(frame);
  const screen = await render(<TitleBarState />);
  try {
    await expect
      .element(page.getByRole("status", { name: "Title bar" }))
      .toHaveTextContent("custom");
  } finally {
    await screen.unmount();
  }
});
