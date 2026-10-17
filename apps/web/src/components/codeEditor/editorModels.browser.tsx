import { QueryClient } from "@tanstack/react-query";
import type { EditorFileEdits, ProjectReadFileResult } from "@synara/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({
  api: { projects: { readFile: vi.fn(), writeFile: vi.fn() } },
}));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => api }));
vi.mock("~/lib/gitReactQuery", () => ({
  refreshGitAfterFileWrite: vi.fn().mockResolvedValue(undefined),
}));
import "./editorRuntime";
import { getWorkspaceEditorSession } from "~/lib/workspaceEditorSession";
import { acquireEditorModel, applyEditorEdits, workspaceDocuments } from "./editorModels";

const clients: QueryClient[] = [];
const handles: ReturnType<typeof acquireEditorModel>[] = [];
const data = (relativePath: string, contents: string): ProjectReadFileResult => ({
  relativePath,
  contents,
  version: `sha256:${contents}`,
  encoding: "utf8",
  lineEnding: "lf",
  truncated: false,
});
function client() {
  const result = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(result);
  return result;
}
function open(queryClient: QueryClient, relativePath: string, contents: string) {
  const session = getWorkspaceEditorSession(queryClient, "/project", relativePath);
  session.load(data(relativePath, contents));
  // Explicitly pause native autosave to inspect the buffer transaction before its separate writer runs.
  session.pause();
  const handle = acquireEditorModel(
    queryClient,
    "/project",
    relativePath,
    contents,
    session.getSnapshot().version,
  );
  handles.push(handle);
  return handle.entry;
}
const edit = (
  relativePath: string,
  expectedContents: string,
  newText: string,
): EditorFileEdits => ({
  relativePath,
  expectedContents,
  edits: [{ start: 0, length: expectedContents.length, newText }],
});
beforeEach(() => {
  api.projects.readFile.mockReset();
  api.projects.writeFile.mockReset();
});
afterEach(() => {
  const entries = new Set(handles.splice(0).map((handle) => handle.entry));
  for (const entry of entries) {
    entry.session?.pause();
    entry.dispose();
  }
  clients.splice(0).forEach((queryClient) => queryClient.clear());
});

it("shares the text model and undo history across editor surfaces, using only the native writer", async () => {
  const queryClient = client();
  const first = open(queryClient, "main.ts", "const before = 1;");
  const second = open(queryClient, "main.ts", "const before = 1;");
  expect(first).toBe(second);
  api.projects.readFile.mockResolvedValue(data("main.ts", "const before = 1;"));
  await applyEditorEdits(first, [edit("main.ts", "const before = 1;", "const after = 2;")]);
  expect(second.model.getValue()).toBe("const after = 2;");
  expect(first.session?.getSnapshot().value).toBe("const after = 2;");
  expect(api.projects.writeFile).not.toHaveBeenCalled();
  await second.model.undo();
  expect(first.model.getValue()).toBe("const before = 1;");
  await first.model.redo();
  expect(second.session?.getSnapshot().value).toBe("const after = 2;");
  api.projects.writeFile.mockResolvedValue({ relativePath: "main.ts", version: "sha256:written" });
  first.session?.save();
  // save() is the native UI callback; flush() awaits the same in-flight writer.
  expect(await first.session?.flush()).toBe(true);
  expect(first.session?.dirty).toBe(false);
  expect(first.session?.getSnapshot().saveError).toBeNull();
  expect(api.projects.writeFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      relativePath: "main.ts",
      contents: "const after = 2;",
      expectedVersion: "sha256:const before = 1;",
    }),
  );
});

it("does not partially mutate a multi-file refactor when one target became stale", async () => {
  const queryClient = client();
  const first = open(queryClient, "main.ts", "first");
  const second = open(queryClient, "other.ts", "second");
  api.projects.readFile.mockImplementation(async ({ relativePath }: { relativePath: string }) =>
    data(relativePath, relativePath === "main.ts" ? "first" : "second"),
  );
  second.session?.change("typed while the compiler was working");
  await expect(
    applyEditorEdits(first, [
      edit("main.ts", "first", "changed"),
      edit("other.ts", "second", "changed"),
    ]),
  ).rejects.toThrow("changed while");
  expect(first.model.getValue()).toBe("first");
  expect(second.model.getValue()).toBe("typed while the compiler was working");
  expect(api.projects.writeFile).not.toHaveBeenCalled();
});

it("rejects external changes and invalid edit spans before touching any document", async () => {
  const queryClient = client();
  const entry = open(queryClient, "main.ts", "original");
  api.projects.readFile.mockResolvedValue(data("main.ts", "external change"));
  await expect(
    applyEditorEdits(entry, [edit("main.ts", "original", "lost change")]),
  ).rejects.toThrow();
  expect(entry.model.getValue()).toBe("external change");
  api.projects.readFile.mockResolvedValue(data("main.ts", "external change"));
  await expect(
    applyEditorEdits(entry, [
      {
        relativePath: "main.ts",
        expectedContents: "external change",
        edits: [
          { start: 0, length: 5, newText: "a" },
          { start: 2, length: 4, newText: "b" },
        ],
      },
    ]),
  ).rejects.toThrow("overlapping");
  expect(entry.model.getValue()).toBe("external change");
});

it("includes unmounted unsaved dependencies, rather than silently reading their older disk contents", () => {
  const queryClient = client();
  const entry = open(queryClient, "main.ts", "import { value } from './dependency';");
  const dependency = getWorkspaceEditorSession(queryClient, "/project", "dependency.ts");
  dependency.load(data("dependency.ts", "export const value = 1;"));
  dependency.pause();
  dependency.change("export const value = 'unsaved';");
  expect(workspaceDocuments(entry)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        relativePath: "dependency.ts",
        contents: "export const value = 'unsaved';",
      }),
    ]),
  );
});
