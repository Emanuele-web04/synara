import { describe, expect, it } from "vitest";

import { revertBrowserStyleEdit, type AppliedBrowserStyleEdit } from "./browserStyleSourceEdit";

const edit: AppliedBrowserStyleEdit = {
  cwd: "/project",
  relativePath: "src/App.tsx",
  line: 1,
  before: '<h1 id="hero">',
  after: '<h1 id="hero" style={{ color: "red" }}>',
};

function fakeProjects(contents: string, truncated = false) {
  const writes: Array<{ cwd: string; relativePath: string; contents: string }> = [];
  return {
    writes,
    projects: {
      readFile: async () => ({ relativePath: edit.relativePath, contents, truncated }),
      writeFile: async (input: { cwd: string; relativePath: string; contents: string }) => {
        writes.push(input);
        return { relativePath: input.relativePath };
      },
    },
  };
}

describe("revertBrowserStyleEdit", () => {
  it("restores the original opening tag, leaving $-patterns intact", async () => {
    const { projects, writes } = fakeProjects(
      'const cost = "$&"; export const App = () => <h1 id="hero" style={{ color: "red" }}>Hi</h1>;',
    );
    await revertBrowserStyleEdit(projects, edit);
    expect(writes).toEqual([
      {
        cwd: "/project",
        relativePath: "src/App.tsx",
        contents: 'const cost = "$&"; export const App = () => <h1 id="hero">Hi</h1>;',
      },
    ]);
  });

  it("refuses when the edited tag is no longer unique", async () => {
    const { projects, writes } = fakeProjects(
      '<h1 id="hero" style={{ color: "red" }}>a</h1><h1 id="hero" style={{ color: "red" }}>b</h1>',
    );
    await expect(revertBrowserStyleEdit(projects, edit)).rejects.toThrow("changed after the edit");
    expect(writes).toEqual([]);
  });

  it("refuses when the edited tag disappeared", async () => {
    const { projects, writes } = fakeProjects("<h1>plain</h1>");
    await expect(revertBrowserStyleEdit(projects, edit)).rejects.toThrow("changed after the edit");
    expect(writes).toEqual([]);
  });

  it("refuses truncated reads", async () => {
    const { projects, writes } = fakeProjects(
      '<h1 id="hero" style={{ color: "red" }}>Hi</h1>',
      true,
    );
    await expect(revertBrowserStyleEdit(projects, edit)).rejects.toThrow("too large to revert");
    expect(writes).toEqual([]);
  });
});
