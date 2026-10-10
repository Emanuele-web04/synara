import { describe, expect, it } from "vitest";

import { withNativeMenuIcons } from "./nativeMenuIcons";

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="currentColor"/></svg>';

describe("withNativeMenuIcons", () => {
  it("rasterizes icons for submenu rows as well as top-level rows", async () => {
    const [group] = await withNativeMenuIcons([
      {
        id: "copy",
        label: "Copy",
        icon: ICON,
        children: [
          { id: "copy-path", label: "Path", icon: ICON },
          { id: "copy-thread-id", label: "Thread ID" },
        ],
      },
    ]);

    expect(group?.iconDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(group?.children?.[0]?.iconDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(group?.children?.[1]).toEqual({ id: "copy-thread-id", label: "Thread ID" });
  });
});
