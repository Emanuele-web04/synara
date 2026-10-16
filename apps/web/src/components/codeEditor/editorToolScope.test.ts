import { describe, expect, it, vi } from "vitest";
import { EditorToolScope, type EditorToolTarget } from "./editorToolScope";

function target(filePath: string): EditorToolTarget {
  return {
    filePath,
    available: ["outline", "problems", "debug", "commands", "extensions"],
    selected: null,
    problemCount: 0,
    debugging: false,
    open: vi.fn(),
  };
}
describe("editor rail command ownership", () => {
  it("routes to the focused editor without crossing shell boundaries", () => {
    const left = new EditorToolScope(),
      right = new EditorToolScope();
    const a = {},
      b = {};
    const first = target("a.ts"),
      second = target("b.ts");
    left.attach(a, first);
    left.attach(b, second);
    right.attach({}, target("other.ts"));
    left.focus(b);
    left.getSnapshot()!.open("outline");
    expect(second.open).toHaveBeenCalledWith("outline");
    expect(first.open).not.toHaveBeenCalled();
    expect(right.getSnapshot()!.filePath).toBe("other.ts");
  });
  it("removes unmounted targets and ignores late updates from an old editor", () => {
    const scope = new EditorToolScope(),
      owner = {};
    const release = scope.attach(owner, target("old.ts"));
    release();
    scope.update(owner, { problemCount: 9 });
    scope.focus(owner);
    expect(scope.getSnapshot()).toBeNull();
    const next = {};
    scope.attach(next, target("new.ts"));
    release();
    expect(scope.getSnapshot()!.filePath).toBe("new.ts");
  });
  it("publishes active diagnostics without disturbing another editor's selection", () => {
    const scope = new EditorToolScope(),
      a = {},
      b = {};
    scope.attach(a, target("a.ts"));
    scope.attach(b, target("b.ts"));
    const listener = vi.fn(),
      release = scope.subscribe(listener);
    scope.update(b, { problemCount: 10 });
    expect(listener).not.toHaveBeenCalled();
    scope.update(a, { problemCount: 2, selected: "problems" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(scope.getSnapshot()).toMatchObject({
      problemCount: 2,
      selected: "problems",
      filePath: "a.ts",
    });
    release();
    scope.focus(b);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
