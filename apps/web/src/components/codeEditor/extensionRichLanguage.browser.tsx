import "../../index.css";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { acquireEditorModel } from "./editorModels";
import { monaco } from "./editorRuntime";
import { extensionInlayHints, extensionSemanticLegend, extensionSemanticTokens, registerNativeExtensionProviders } from "./extensionLanguageProviders";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });
function model() {
  const value = monaco.editor.createModel("const answer = 42;\nlet next = answer;\n", "javascript");
  cleanups.push(() => value.dispose());
  return value;
}
const legend = { tokenTypes: ["variable"], tokenModifiers: ["declaration"] };

it("copies Code-OSS full semantic tuples into a native typed array", () => {
  const source = model();
  const raw = { data: [0, 6, 6, 0, 1, 1, 4, 4, 0, 1] };
  const result = extensionSemanticTokens(source, raw, extensionSemanticLegend(legend));
  expect(result.data).toBeInstanceOf(Uint32Array);
  expect([...result.data]).toEqual(raw.data);
  raw.data[0] = 100;
  expect(result.data[0]).toBe(0);
  expect(result.resultId).toBeUndefined();
});

it.each([
  [0, 6],
  [0, 6, 0, 0, 0],
  [0, 6, 6, 1, 0],
  [0, 6, 6, 0, 2],
  [10, 0, 1, 0, 0],
  [0, 100, 1, 0, 0],
  [0, 0, 5, 0, 0, 0, 2, 2, 0, 0],
  [0, -1, 1, 0, 0],
])("rejects malformed, out-of-document or overlapping token payload %j", (...data) => {
  expect(() => extensionSemanticTokens(model(), { data }, legend)).toThrow();
});

it("limits semantic legends and token allocations", () => {
  expect(() => extensionSemanticLegend({ tokenTypes: [""], tokenModifiers: [] })).toThrow();
  expect(() => extensionSemanticLegend({ tokenTypes: ["variable"], tokenModifiers: Array(33).fill("x") })).toThrow();
  expect(() => extensionSemanticTokens(model(), { data: Array(250_005).fill(0) }, legend)).toThrow();
});

it("uses native hints without trusting Markdown or activating cached commands", () => {
  const result = extensionInlayHints(model(), [{ position: { lineNumber: 1, column: 13 }, kind: 1,
    label: [{ label: ": number", command: { id: "unsafe.command" }, location: { uri: "file:///outside" },
      tooltip: { value: "**A type**", isTrusted: true, supportHtml: true } }],
    tooltip: { value: "<script>not executable</script>", isTrusted: true },
    paddingRight: true, textEdits: [{ range: {}, text: "must not apply" }],
  }]);
  expect(result.hints).toHaveLength(1);
  expect(result.hints[0]).toMatchObject({ position: { lineNumber: 1, column: 13 }, kind: 1, paddingRight: true,
    tooltip: { isTrusted: false, supportHtml: false }, label: [{ label: ": number", tooltip: { isTrusted: false, supportHtml: false } }] });
  expect(result.hints[0]!.textEdits).toBeUndefined();
  expect(result.hints[0]!.label).toEqual([{ label: ": number", tooltip: { value: "**A type**", isTrusted: false, supportHtml: false } }]);
  result.dispose();
});

it("rejects a clamped or empty inlay hint rather than rendering misleading information", () => {
  const source = model();
  expect(() => extensionInlayHints(source, [{ position: { lineNumber: 1, column: 500 }, label: "x" }])).toThrow("leaves its document");
  expect(() => extensionInlayHints(source, [{ position: { lineNumber: 1, column: 1 }, label: [] }])).toThrow("empty label");
});

it("registers both provider kinds only for their native workspace and language", async () => {
  const client = new QueryClient();
  const acquired = acquireEditorModel(client, "/workspace", "file.js", "const answer = 42;", 1);
  cleanups.push(() => { acquired.release(); acquired.entry.dispose(); client.clear(); });
  const hints = vi.spyOn(monaco.languages, "registerInlayHintsProvider");
  const tokens = vi.spyOn(monaco.languages, "registerDocumentSemanticTokensProvider");
  const provide = vi.fn(async (_entry: unknown, handle: number) => handle === 1 ? { data: [0, 6, 6, 0, 1] } : [{ position: { lineNumber: 1, column: 13 }, label: ": number" }]);
  const registrations = registerNativeExtensionProviders({ client, cwd: "/workspace", provide }, [
    { kind: "semanticTokens", handle: 1, label: "Fixture", selector: [{ language: "javascript", scheme: "file" }], metadata: [legend] },
    { kind: "inlayHints", handle: 2, label: "Fixture", selector: [{ language: "javascript", scheme: "file" }] },
  ]);
  cleanups.push(() => registrations.forEach((registration) => registration.dispose()));
  expect(tokens.mock.calls[0]![0]).toEqual([{ language: "javascript", scheme: "synara-workspace" }]);
  expect(hints.mock.calls[0]![0]).toEqual([{ language: "javascript", scheme: "synara-workspace" }]);
  const cancellation = new monaco.CancellationTokenSource();
  cleanups.push(() => cancellation.dispose());
  const tokenResult = await tokens.mock.calls[0]![1].provideDocumentSemanticTokens(acquired.entry.model, null, cancellation.token);
  expect(tokenResult && "data" in tokenResult ? [...tokenResult.data] : []).toEqual([0, 6, 6, 0, 1]);
  const hintResult = await hints.mock.calls[0]![1].provideInlayHints(acquired.entry.model, acquired.entry.model.getFullModelRange(), cancellation.token);
  expect(hintResult?.hints[0]?.label).toBe(": number");
  hintResult?.dispose();
  const unrelated = model();
  expect(await tokens.mock.calls[0]![1].provideDocumentSemanticTokens(unrelated, null, cancellation.token)).toBeNull();
  expect(provide).toHaveBeenCalledTimes(2);
});
