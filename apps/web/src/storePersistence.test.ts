// FILE: storePersistence.test.ts
// Purpose: Unit-test the renderer-state persistence layer for project UI.

import { ProjectId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeFakeWindow, makeProject } from "./storeTestFixtures";
import { initialState } from "./storeState";
import type { AppState } from "./storeState";
import { PERSISTED_STATE_KEY } from "./storePersistence";

async function importStorePersistence(storage: Map<string, string>) {
  vi.stubGlobal("window", makeFakeWindow(storage));
  vi.resetModules();
  return import("./storePersistence");
}

describe("storePersistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ignores malformed persisted shapes and falls back to defaults", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectOrderCwds: "not-an-array",
        expandedProjectCwds: "also-not-an-array",
        projectNamesByCwd: ["not-a-record"],
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    expect(() => readPersistedState(initialState)).not.toThrow();
    const remembered = getRememberedProjectUiState();
    expect(remembered.expandedProjectCount).toBe(0);
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.projectNameForCwd("/tmp/project-1")).toBeUndefined();
  });

  it("preserves legacy payloads that contain only expandedProjectCwds", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds: ["/tmp/project-1"],
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    readPersistedState(initialState);
    const remembered = getRememberedProjectUiState();
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(true);
    expect(remembered.isProjectExpanded("/tmp/project-2")).toBe(false);
  });

  it("does not treat a modern empty persisted payload as a legacy all-collapsed list", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectOrderCwds: [],
        expandedProjectCwds: [],
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    readPersistedState(initialState);
    const remembered = getRememberedProjectUiState();
    expect(remembered.isLegacyExpansionPayload).toBe(false);
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.expandedProjectCount).toBe(0);
  });

  it("removes a deleted project from both persisted project lists on the next write", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    vi.stubGlobal("window", fakeWindow);
    vi.resetModules();
    const { persistState } = await import("./storePersistence");
    const state: AppState = {
      ...initialState,
      threadsHydrated: true,
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          cwd: "/tmp/project-1",
          expanded: true,
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          cwd: "/tmp/project-2",
          expanded: false,
        }),
      ],
    };
    persistState(state);

    const next: AppState = {
      ...initialState,
      threadsHydrated: true,
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          cwd: "/tmp/project-1",
          expanded: true,
        }),
      ],
    };
    persistState(next);

    const payload = JSON.parse(storage.get(PERSISTED_STATE_KEY) ?? "{}");
    expect(payload.projectOrderCwds).not.toContain("/tmp/project-2");
    expect(payload.expandedProjectCwds).not.toContain("/tmp/project-2");
    expect(payload.projectOrderCwds).toEqual(["/tmp/project-1"]);
    expect(payload.expandedProjectCwds).toEqual(["/tmp/project-1"]);
  });

  it("reindexes a known project to match its current position", async () => {
    const storage = new Map<string, string>();
    const { rememberProjectState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    const project = (id: string, cwd: string) => makeProject({ id: ProjectId.makeUnsafe(id), cwd });
    rememberProjectState([
      project("project-1", "/tmp/project-1"),
      project("project-2", "/tmp/project-2"),
    ]);
    expect(getRememberedProjectUiState().projectOrderIndexForCwd("/tmp/project-1")).toBe(0);

    rememberProjectState([
      project("project-2", "/tmp/project-2"),
      project("project-1", "/tmp/project-1"),
    ]);

    expect(getRememberedProjectUiState().projectOrderIndexForCwd("/tmp/project-2")).toBe(0);
    expect(getRememberedProjectUiState().projectOrderIndexForCwd("/tmp/project-1")).toBe(1);
  });

  it("resets remembered state when the persisted key disappears on a later read", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectOrderCwds: ["/tmp/project-1"],
        expandedProjectCwds: ["/tmp/project-1"],
        projectNamesByCwd: { "/tmp/project-1": "alpha" },
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    readPersistedState(initialState);
    expect(getRememberedProjectUiState().projectOrderCount).toBe(1);

    storage.delete(PERSISTED_STATE_KEY);
    readPersistedState(initialState);
    const remembered = getRememberedProjectUiState();
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.expandedProjectCount).toBe(0);
    expect(remembered.projectNameForCwd("/tmp/project-1")).toBeUndefined();
    expect(remembered.isLegacyExpansionPayload).toBe(false);
  });

  it("resets remembered state when the stored value becomes corrupt on a later read", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectOrderCwds: ["/tmp/project-1"],
        expandedProjectCwds: ["/tmp/project-1"],
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    readPersistedState(initialState);
    expect(getRememberedProjectUiState().projectOrderCount).toBe(1);

    storage.set(PERSISTED_STATE_KEY, '"{"');
    readPersistedState(initialState);
    const remembered = getRememberedProjectUiState();
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.expandedProjectCount).toBe(0);
    expect(remembered.isLegacyExpansionPayload).toBe(false);
  });

  it("swallows localStorage write failures instead of breaking the caller", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    fakeWindow.localStorage.setItem.mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    vi.stubGlobal("window", fakeWindow);
    vi.resetModules();
    const { persistState } = await import("./storePersistence");
    const state: AppState = {
      ...initialState,
      threadsHydrated: true,
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          cwd: "/tmp/project-1",
          expanded: true,
        }),
      ],
    };
    expect(() => persistState(state)).not.toThrow();
    expect(storage.has(PERSISTED_STATE_KEY)).toBe(false);
  });
});
