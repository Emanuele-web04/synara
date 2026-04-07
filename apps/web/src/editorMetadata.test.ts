import { describe, expect, it } from "vitest";
import { resolveAvailableEditorOptions, resolveEditorLabel } from "./editorMetadata";

describe("resolveEditorLabel", () => {
  it("uses platform-specific labels for the file manager option", () => {
    expect(resolveEditorLabel("file-manager", "MacIntel")).toBe("Finder");
    expect(resolveEditorLabel("file-manager", "Win32")).toBe("Explorer");
    expect(resolveEditorLabel("file-manager", "Linux x86_64")).toBe("Files");
  });
});

describe("resolveAvailableEditorOptions", () => {
  it("surfaces every supported available editor from the shared contracts catalog", () => {
    expect(
      resolveAvailableEditorOptions("MacIntel", [
        "cursor",
        "trae",
        "vscode-insiders",
        "vscodium",
        "idea",
        "file-manager",
      ]).map((option) => option.value),
    ).toEqual(["cursor", "trae", "vscode-insiders", "vscodium", "idea", "file-manager"]);
  });
});
