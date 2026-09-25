import { describe, expect, it } from "vitest";
import { EDITOR_ICON_ROUTE_PATH } from "@synara/shared/editorIcons";
import { resolveEditorNativeIconUrl } from "./editorMetadata";

describe("resolveEditorNativeIconUrl", () => {
  it("builds authenticated editor icon route urls", () => {
    expect(resolveEditorNativeIconUrl("ghostty")).toContain(`${EDITOR_ICON_ROUTE_PATH}?id=ghostty`);
  });
});
