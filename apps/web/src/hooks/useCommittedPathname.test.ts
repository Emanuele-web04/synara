// FILE: useCommittedPathname.test.ts
// Purpose: Locks the committed pathname to `location.pathname` across the real route tree.
// Layer: Web routing hook tests
// Depends on: the generated route tree, driven through TanStack memory history

import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { routeTree } from "../routeTree.gen";
import { resolveCommittedPathname } from "./useCommittedPathname";

interface StoreSnapshot {
  readonly committedPathname: string;
  readonly locationPathname: string;
  readonly matchIds: readonly string[];
  readonly params: unknown;
}

function describeMatches(matches: ReadonlyArray<{ id: string; params: unknown }>) {
  return { matchIds: matches.map((match) => match.id), params: matches.at(-1)?.params };
}

// Folds every router store update through the hook's selector, exactly as a mounted
// subscriber would see them.
function createHarness(initialPath: string) {
  const history = createMemoryHistory({ initialEntries: [initialPath] });
  const router = createRouter({
    routeTree,
    history,
    context: { queryClient: new QueryClient() },
    // Node has no document; keep the client store the app subscribes to.
    isServer: false,
    origin: "http://localhost",
  });
  let heldPathname: string | null = null;
  const snapshots: StoreSnapshot[] = [];
  router.__store.subscribe(() => {
    const state = router.state;
    heldPathname = resolveCommittedPathname(state, heldPathname);
    snapshots.push({
      committedPathname: heldPathname,
      locationPathname: state.location.pathname,
      ...describeMatches(state.matches),
    });
  });

  return {
    router,
    snapshots,
    committedPathname: () => heldPathname,
    visit: async (path: string) => {
      history.push(path);
      await router.load();
    },
    // The committed pathname must always be one that resolves to the rendered matches,
    // so it can never disagree with what `useParams`/`useSearch` report.
    expectCoherentSnapshots: () => {
      const rendered = snapshots.filter((snapshot) => snapshot.matchIds.length > 0);
      expect(rendered.length).toBeGreaterThan(0);
      for (const snapshot of rendered) {
        expect({
          pathname: snapshot.committedPathname,
          ...describeMatches(router.matchRoutes(snapshot.committedPathname)),
        }).toEqual({
          pathname: snapshot.committedPathname,
          matchIds: snapshot.matchIds,
          params: snapshot.params,
        });
      }
    },
  };
}

// Every route in apps/web/src/routes, in both trailing-slash forms.
function listRoutePaths(router: ReturnType<typeof createHarness>["router"]): string[] {
  const paths = new Set<string>();
  for (const route of Object.values(router.routesById)) {
    const fullPath = route.fullPath.replace(/\$(\w+)/g, "sample-$1");
    const trimmed = fullPath.replace(/\/+$/, "");
    paths.add(trimmed === "" ? "/" : trimmed);
    paths.add(`${trimmed}/`);
  }
  return [...paths];
}

describe("resolveCommittedPathname", () => {
  it("stays string-identical to location.pathname on every route", async () => {
    const harness = createHarness("/");
    await harness.router.load();
    const paths = [...listRoutePaths(harness.router), "/unknown/nested/path"];
    expect(paths).toEqual(
      expect.arrayContaining(["/", "/sample-threadId", "/pull-requests", "/pull-requests/"]),
    );

    for (const path of paths) {
      await harness.visit(path);
      expect(harness.router.state.isLoading).toBe(false);
      expect(harness.committedPathname()).toBe(harness.router.state.location.pathname);
    }

    harness.expectCoherentSnapshots();
    // The first visit to each route imports its lazy chunk, which is slow in a busy run.
  }, 60_000);

  it("keeps both trailing-slash forms of an index route distinct", async () => {
    const harness = createHarness("/pull-requests/");
    await harness.router.load();
    expect(harness.committedPathname()).toBe("/pull-requests/");

    await harness.visit("/settings");
    await harness.visit("/pull-requests");
    expect(harness.committedPathname()).toBe("/pull-requests");
  });

  it("changes once per navigation, in the update that commits the new matches", async () => {
    const harness = createHarness("/thread-a");
    await harness.router.load();
    const start = harness.snapshots.length;

    await harness.visit("/thread-b");

    const navigation = harness.snapshots.slice(start);
    // The premise of the hook: the location is published before the matches are.
    expect(navigation[0]).toMatchObject({
      locationPathname: "/thread-b",
      committedPathname: "/thread-a",
      params: { threadId: "thread-a" },
    });
    const changes = navigation.filter(
      (snapshot, index) =>
        snapshot.committedPathname !== (navigation[index - 1]?.committedPathname ?? "/thread-a"),
    );
    expect(changes).toEqual([
      expect.objectContaining({
        committedPathname: "/thread-b",
        params: { threadId: "thread-b" },
      }),
    ]);
    harness.expectCoherentSnapshots();
  });

  it("stays coherent through redirects and interrupted navigations", async () => {
    const harness = createHarness("/thread-a");
    await harness.router.load();

    // `/groups` redirects in `beforeLoad`, so its location never gets matches.
    await harness.visit("/groups");
    expect(harness.committedPathname()).toBe(harness.router.state.location.pathname);
    expect(harness.snapshots.map((snapshot) => snapshot.committedPathname)).not.toContain(
      "/groups",
    );

    const interrupted = harness.router.navigate({ to: "/settings" });
    await harness.router.navigate({ to: "/$threadId", params: { threadId: "thread-b" } });
    await interrupted;
    expect(harness.committedPathname()).toBe("/thread-b");

    harness.expectCoherentSnapshots();
  });

  it("falls back to the resolved location for a subscriber mounted mid-navigation", () => {
    const pending = { isLoading: true, location: { pathname: "/thread-b" } };

    expect(
      resolveCommittedPathname({ ...pending, resolvedLocation: { pathname: "/thread-a" } }, null),
    ).toBe("/thread-a");
    expect(resolveCommittedPathname(pending, null)).toBe("/thread-b");
    expect(resolveCommittedPathname(pending, "/held")).toBe("/held");
  });
});
