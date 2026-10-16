import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { rememberEditorView, takeEditorView } from "./editorViewHandoff";

describe("native editor view handoff", () => {
  it("scopes presentation state to the client, workspace, file and destination", () => {
    const client = new QueryClient();
    const view = { target: "editor" as const, lineNumber: 70, lineFraction: 0.5, scrollLeft: 100 };
    rememberEditorView(client, "/a", "same.ts", view);
    expect(takeEditorView(new QueryClient(), "/a", "same.ts", "editor")).toBeUndefined();
    expect(takeEditorView(client, "/b", "same.ts", "editor")).toBeUndefined();
    expect(takeEditorView(client, "/a", "other.ts", "editor")).toBeUndefined();
    expect(takeEditorView(client, "/a", "same.ts", "preview")).toBeUndefined();
    expect(takeEditorView(client, "/a", "same.ts", "editor")).toEqual(view);
    expect(takeEditorView(client, "/a", "same.ts", "editor")).toBeUndefined();
  });
  it("bounds retained view state without holding document contents", () => {
    const client = new QueryClient();
    for (let index = 0; index <= 100; index++)
      rememberEditorView(client, "/a", `${index}.ts`, {
        target: "preview",
        lineNumber: index + 1,
        lineFraction: 0,
        scrollLeft: 0,
      });
    expect(takeEditorView(client, "/a", "0.ts", "preview")).toBeUndefined();
    expect(takeEditorView(client, "/a", "100.ts", "preview")?.lineNumber).toBe(101);
  });
});
