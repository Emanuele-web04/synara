export type EditorCenterMode = "file" | "diff" | "fileEdit" | "diffEdit";

export function editorCenterModeFamily(mode: EditorCenterMode): "file" | "diff" {
  return mode === "diff" || mode === "diffEdit" ? "diff" : "file";
}
