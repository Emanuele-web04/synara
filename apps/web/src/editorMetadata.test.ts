import { describe, expect, it } from "vitest";
import { EDITOR_ICON_ROUTE_PATH } from "@synara/shared/editorIcons";
import { resolveEditorLabel, resolveEditorNativeIconUrl } from "./editorMetadata";

describe("resolveEditorLabel", () => {
  it("uses platform-specific labels for the file manager option", () => {
    expect(resolveEditorLabel("file-manager", "MacIntel")).toBe("Finder");
    expect(resolveEditorLabel("file-manager", "Win32")).toBe("Explorer");
    expect(resolveEditorLabel("file-manager", "Linux x86_64")).toBe("File manager");
  });
});

describe("resolveEditorNativeIconUrl", () => {
  it("builds authenticated editor icon route urls", () => {
    expect(resolveEditorNativeIconUrl("ghostty")).toContain(`${EDITOR_ICON_ROUTE_PATH}?id=ghostty`);
  });
});
