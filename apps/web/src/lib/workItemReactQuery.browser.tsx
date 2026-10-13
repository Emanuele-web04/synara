// FILE: workItemReactQuery.browser.tsx
// Purpose: Verifies the composer work item search debounce fires one request
//          per settled input after the 300ms window.
// Layer: Browser UI test

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WORK_ITEMS_SEARCH_DEBOUNCE_MS,
  useDebouncedWorkItemsSearch,
  useWorkItemsAvailability,
} from "./workItemReactQuery";

const searchCalls = vi.hoisted(
  () => [] as Array<{ at: number; query: string; signal?: AbortSignal }>,
);
const availabilityCalls = vi.hoisted(() => [] as AbortSignal[]);
const pending = vi.hoisted(() => ({ enabled: false }));

vi.mock("~/nativeApi", () => ({
  onNativeApiServerCapabilitiesChange: () => () => undefined,
  readNativeApiServerCapability: () => true,
  ensureNativeApi: () => ({
    workItems: {
      availability: async (_input: { cwd: string }, options?: { signal?: AbortSignal }) => {
        availabilityCalls.push(options!.signal!);
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          }),
        );
      },
      search: async (
        input: { cwd: string; query: string; limit: number },
        options?: { signal?: AbortSignal },
      ) => {
        searchCalls.push({
          at: Date.now(),
          query: input.query,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (pending.enabled)
          return new Promise((_resolve, reject) =>
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            }),
          );
        return { available: true, errorHint: null, items: [] };
      },
    },
  }),
}));

let queryClient: QueryClient;

function SearchProbe({ cwd, query }: { cwd: string; query: string }) {
  useDebouncedWorkItemsSearch(cwd, query, true);
  return null;
}

describe("useDebouncedWorkItemsSearch", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    searchCalls.length = 0;
    availabilityCalls.length = 0;
    pending.enabled = false;
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("waits the 300ms debounce before issuing a changed search", async () => {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <SearchProbe cwd="/repo" query="" />
      </QueryClientProvider>,
    );

    // The initial empty query issues its request immediately (recent list).
    await vi.waitFor(() => {
      expect(searchCalls.length).toBe(1);
    });

    const rerenderStart = Date.now();
    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <SearchProbe cwd="/repo" query="scroll bug" />
      </QueryClientProvider>,
    );

    // Half the debounce window: the typed query must not have fired yet.
    await new Promise((resolve) => setTimeout(resolve, WORK_ITEMS_SEARCH_DEBOUNCE_MS / 2));
    expect(searchCalls).toHaveLength(1);

    // Past the window: exactly one additional request carries the typed query.
    await vi.waitFor(
      () => {
        expect(searchCalls.length).toBe(2);
      },
      { timeout: WORK_ITEMS_SEARCH_DEBOUNCE_MS * 4 },
    );
    expect(searchCalls[1]?.query).toBe("scroll bug");
    expect(searchCalls[1]!.at - rerenderStart).toBeGreaterThanOrEqual(
      WORK_ITEMS_SEARCH_DEBOUNCE_MS - 40,
    );

    await screen.unmount();
  });
  it("aborts the superseded request and its unmounted replacement", async () => {
    pending.enabled = true;
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <SearchProbe cwd="/repo" query="" />
      </QueryClientProvider>,
    );
    try {
      await vi.waitFor(() => expect(searchCalls).toHaveLength(1));
      const first = searchCalls[0]!.signal!;
      expect(first.aborted).toBe(false);
      await screen.rerender(
        <QueryClientProvider client={queryClient}>
          <SearchProbe cwd="/repo" query="current" />
        </QueryClientProvider>,
      );
      await vi.waitFor(() => expect(searchCalls).toHaveLength(2));
      expect(first.aborted).toBe(true);
      const current = searchCalls[1]!.signal!;
      expect(current.aborted).toBe(false);
      await screen.unmount();
      expect(current.aborted).toBe(true);
    } finally {
      queryClient.clear();
    }
  });
  it("aborts availability probes after workspace changes and unmount", async () => {
    function Probe({ cwd }: { cwd: string }) {
      useWorkItemsAvailability(cwd);
      return null;
    }
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <Probe cwd="/first" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(availabilityCalls).toHaveLength(1));
    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <Probe cwd="/second" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(availabilityCalls).toHaveLength(2));
    expect(availabilityCalls[0]!.aborted).toBe(true);
    await screen.unmount();
    expect(availabilityCalls[1]!.aborted).toBe(true);
  });
  it("bounds pasted searches before the RPC", async () => {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <SearchProbe cwd="/repo" query={"x".repeat(300)} />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(searchCalls).toHaveLength(1));
    expect(searchCalls[0]!.query).toHaveLength(256);
    await screen.unmount();
  });
});
