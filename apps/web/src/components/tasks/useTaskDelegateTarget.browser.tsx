import { ProjectId } from "@synara/contracts";
import { expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useStore } from "../../store";
import { makeProject } from "../../storeTestFixtures";
import { useTaskDelegateTarget } from "./useTaskDelegateTarget";

it("follows task project edits until Run in is explicitly chosen", async () => {
  const previous = useStore.getState().projects;
  const first = makeProject({ id: ProjectId.makeUnsafe("target-first") });
  const second = makeProject({ id: ProjectId.makeUnsafe("target-second") });
  useStore.setState({ projects: [first, second] });
  let projectId = first.id;
  const hook = await renderHook(() => useTaskDelegateTarget(projectId));
  try {
    expect(hook.result.current.target).toEqual({ kind: "project", projectId: first.id });
    projectId = second.id;
    await hook.rerender();
    expect(hook.result.current.target).toEqual({ kind: "project", projectId: second.id });
    hook.result.current.setTarget({ kind: "folder", path: "/chosen/folder" });
    await hook.rerender();
    projectId = first.id;
    await hook.rerender();
    expect(hook.result.current.target).toEqual({ kind: "folder", path: "/chosen/folder" });
    hook.result.current.setTarget({ kind: "project", projectId: second.id });
    await hook.rerender();
    projectId = second.id;
    await hook.rerender();
    projectId = first.id;
    await hook.rerender();
    expect(hook.result.current.target).toEqual({ kind: "project", projectId: second.id });
  } finally {
    await hook.unmount();
    useStore.setState({ projects: previous });
  }
});
