import { ProjectId } from "@synara/contracts";
import { expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useLatestProjectStore } from "../../latestProjectStore";
import { useStore } from "../../store";
import { makeProject } from "../../storeTestFixtures";
import { useTaskDelegateTarget } from "./useTaskDelegateTarget";

it("follows task project edits until Run in is explicitly chosen", async () => {
  const previous = useStore.getState().projects;
  const previousLatest = useLatestProjectStore.getState().latestProjectId;
  const first = makeProject({ id: ProjectId.makeUnsafe("target-first") });
  const second = makeProject({ id: ProjectId.makeUnsafe("target-second") });
  useStore.setState({ projects: [first, second] });
  useLatestProjectStore.getState().setLatestProjectId(first.id);
  let projectId: ProjectId | null = null;
  const hook = await renderHook(() => useTaskDelegateTarget(projectId));
  try {
    expect(hook.result.current.target).toEqual({ kind: "project", projectId: first.id });
    // An unrelated chat-layout selection and project reorder must not move this task.
    useLatestProjectStore.getState().setLatestProjectId(second.id);
    useStore.setState({ projects: [second, first] });
    await hook.rerender();
    expect(hook.result.current.target).toEqual({ kind: "project", projectId: first.id });
    useStore.setState({ projects: [second] });
    await hook.rerender();
    expect(hook.result.current.target).toBeNull();
    projectId = second.id;
    await hook.rerender();
    expect(hook.result.current.target).toEqual({ kind: "project", projectId: second.id });
    useStore.setState({ projects: [first] });
    await hook.rerender();
    expect(hook.result.current.target).toBeNull();
    useStore.setState({ projects: [second, first] });
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
    useLatestProjectStore.setState({ latestProjectId: previousLatest });
  }
});
