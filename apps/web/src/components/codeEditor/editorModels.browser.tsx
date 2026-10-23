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
import {
  acquireEditorModel,
  applyEditorEdits,
  editorUri,
  ensureEditorModels,
  entryForUri,
  workspaceDocuments,
} from "./editorModels";

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

it("releases peek models with the last surface, even when two documents peek each other", async () => {
  const queryClient = client();
  api.projects.readFile.mockImplementation(async ({ relativePath }: { relativePath: string }) =>
    data(relativePath, `// ${relativePath}`),
  );
  const first = open(queryClient, "first.ts", "// first.ts");
  const firstHandle = handles.at(-1)!;
  const second = open(queryClient, "second.ts", "// second.ts");
  const secondHandle = handles.at(-1)!;
  await ensureEditorModels(first, ["second.ts"]);
  await ensureEditorModels(second, ["first.ts"]);
  expect(first.dependencies.has("second.ts")).toBe(true);
  expect(second.dependencies.has("first.ts")).toBe(true);
  expect(first.references).toBe(2);
  expect(second.references).toBe(2);
  firstHandle.release();
  secondHandle.release();
  expect(first.dependencies.size).toBe(0);
  expect(second.dependencies.size).toBe(0);
  expect(first.references).toBe(0);
  expect(second.references).toBe(0);
});

it("holds at most 64 peek models per document, counting loads in flight", async () => {
  const queryClient = client();
  api.projects.readFile.mockImplementation(async ({ relativePath }: { relativePath: string }) =>
    data(relativePath, `// ${relativePath}`),
  );
  const entry = open(queryClient, "main.ts", "// main.ts");
  const paths = Array.from({ length: 70 }, (_, index) => `dep${index}.ts`);
  await ensureEditorModels(entry, paths);
  expect(entry.dependencies.size).toBe(64);
  expect(api.projects.readFile).toHaveBeenCalledTimes(64);
  handles.at(-1)!.release();
  expect(entry.dependencies.size).toBe(0);
});

it("loads nested peek targets within the visible document's budget and releases them with it", async () => {
  const queryClient = client();
  api.projects.readFile.mockImplementation(async ({ relativePath }: { relativePath: string }) =>
    data(relativePath, `// ${relativePath}`),
  );
  const entry = open(queryClient, "main.ts", "// main.ts");
  await ensureEditorModels(entry, ["second.ts"]);
  const second = entryForUri(editorUri(queryClient, "/project", "second.ts"))!;
  expect(second.surfaces).toBe(0);
  await ensureEditorModels(second, ["third.ts"]);
  const third = entryForUri(editorUri(queryClient, "/project", "third.ts"));
  expect(third?.model.getValue()).toBe("// third.ts");
  await ensureEditorModels(
    second,
    Array.from({ length: 70 }, (_, index) => `nested${index}.ts`),
  );
  expect(api.projects.readFile).toHaveBeenCalledTimes(64);
  await ensureEditorModels(third!, ["main.ts"]);
  handles.at(-1)!.release();
  expect(second.references).toBe(0);
  expect(third?.references).toBe(0);
});

it.each([false, true])(
  "holds nested peek targets for every owner (intermediate visible: %s)",
  async (intermediateVisible) => {
    const queryClient = client();
    api.projects.readFile.mockImplementation(async ({ relativePath }: { relativePath: string }) =>
      data(relativePath, `// ${relativePath}`),
    );
    const first = open(queryClient, "first.ts", "// first.ts");
    const firstHandle = handles.at(-1)!;
    const other = open(queryClient, "other.ts", "// other.ts");
    const otherHandle = handles.at(-1)!;
    if (intermediateVisible) open(queryClient, "shared.ts", "// shared.ts");
    const intermediateHandle = intermediateVisible ? handles.at(-1)! : null;
    await ensureEditorModels(first, ["shared.ts"]);
    await ensureEditorModels(other, ["shared.ts"]);
    const shared = entryForUri(editorUri(queryClient, "/project", "shared.ts"))!;
    let completeRead!: (value: ProjectReadFileResult) => void;
    api.projects.readFile.mockImplementationOnce(
      () =>
        new Promise<ProjectReadFileResult>((resolve) => {
          completeRead = resolve;
        }),
    );
    const firstLoad = ensureEditorModels(first, ["nested.ts"]);
    await vi.waitFor(() => expect(completeRead).toBeDefined());
    const sharedLoad = ensureEditorModels(shared, ["nested.ts"]);
    completeRead(data("nested.ts", "// nested.ts"));
    await Promise.all([firstLoad, sharedLoad]);
    expect(first.dependencies.has("nested.ts")).toBe(true);
    const nested = entryForUri(editorUri(queryClient, "/project", "nested.ts"))!;
    intermediateHandle?.release();
    firstHandle.release();
    expect(other.dependencies.has("nested.ts")).toBe(true);
    expect(nested.references).toBe(1);
    expect(nested.model.getValue()).toBe("// nested.ts");
    otherHandle.release();
    expect(nested.references).toBe(0);
  },
);

it("reports failed navigation reads without discarding partial results or retrying admission", async () => {
  const queryClient = client();
  const entry = open(queryClient, "main.ts", "// main.ts");
  const capacity = Object.assign(new Error("WebSocket expensive-read request capacity exceeded."), {
    code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
    retryable: true,
    retryAfterMs: 250,
  });
  api.projects.readFile.mockRejectedValue(capacity);
  await ensureEditorModels(entry, ["blocked.ts"]);
  expect(entry.status).toBe("Workspace file reads are busy. Try the command again.");
  expect(api.projects.readFile).toHaveBeenCalledTimes(1);
  api.projects.readFile.mockImplementation(async ({ relativePath }: { relativePath: string }) => {
    if (relativePath === "blocked.ts") throw capacity;
    return data(relativePath, `// ${relativePath}`);
  });
  await ensureEditorModels(entry, ["main.ts", "blocked.ts"]);
  await ensureEditorModels(entry, ["blocked.ts", "available.ts"]);
  expect(entryForUri(editorUri(queryClient, "/project", "available.ts"))?.model.getValue()).toBe(
    "// available.ts",
  );
});
