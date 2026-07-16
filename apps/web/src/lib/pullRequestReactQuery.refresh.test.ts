import type { ProjectId } from "@synara/contracts";
import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "../nativeApi";
import {
  pullRequestActionMutationOptions,
  pullRequestMutationKeys,
  pullRequestQueryKeys,
  pullRequestSetPinnedMutationOptions,
  pullRequestsExactInvolvementQueryOptions,
  pullRequestsForceRefreshMutationOptions,
} from "./pullRequestReactQuery";
import { deferred } from "./pullRequestReactQuery.testUtils";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pullRequestsForceRefreshMutationOptions", () => {
  it("uses a separate pin scope and the same guarded scope as PR actions", () => {
    const queryClient = new QueryClient();
    const pin = pullRequestSetPinnedMutationOptions(queryClient);
    const action = pullRequestActionMutationOptions(queryClient);
    const refresh = pullRequestsForceRefreshMutationOptions(queryClient);

    expect(pin.scope).toBeUndefined();
    expect(action.scope?.id).toBe(refresh.scope?.id);
    expect(action.mutationKey).toEqual(pullRequestMutationKeys.action);
    expect(refresh.mutationKey).toEqual(pullRequestMutationKeys.forceRefresh);
  });

  it("does not dispatch a forced snapshot until a concurrent action settles", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const actionGate = deferred<Record<string, never>>();
    const callOrder: string[] = [];
    const action = vi.fn(async () => {
      callOrder.push("action:start");
      const result = await actionGate.promise;
      callOrder.push("action:end");
      return result;
    });
    const list = vi.fn(async () => {
      callOrder.push("refresh");
      return { viewer: "octocat", entries: [], errors: [], repositoryBatches: [] };
    });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      pullRequests: { action, list },
    } as never);

    const mutationCache = queryClient.getMutationCache();
    const actionMutation = mutationCache.build(
      queryClient,
      pullRequestActionMutationOptions(queryClient),
    );
    const refreshMutation = mutationCache.build(
      queryClient,
      pullRequestsForceRefreshMutationOptions(queryClient),
    );
    const actionPromise = actionMutation.execute({
      projectId,
      repository: "acme/widgets",
      number: 42,
      action: "merge",
    });
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());

    const refreshPromise = refreshMutation.execute({ state: "open", projectId });
    await Promise.resolve();
    expect(list).not.toHaveBeenCalled();

    actionGate.resolve({});
    await actionPromise;
    await refreshPromise;
    expect(callOrder).toEqual(["action:start", "action:end", "refresh"]);
  });

  it("does not let a refresh that started first repaint an action's optimistic fields", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const identity = { projectId, repository: "acme/widgets", number: 42 } as const;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
    queryClient.setQueryData(listKey, {
      viewer: "octocat",
      entries: [{ ...identity, state: "open", isDraft: false, isPinned: false }],
      errors: [],
      repositoryBatches: [],
    });
    const refreshGate = deferred<{
      viewer: string;
      entries: Array<typeof identity & { state: "open"; isDraft: boolean; isPinned: boolean }>;
      errors: [];
      repositoryBatches: [];
    }>();
    const actionGate = deferred<Record<string, never>>();
    const list = vi.fn(() => refreshGate.promise);
    const action = vi.fn(() => actionGate.promise);
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      pullRequests: { action, list },
    } as never);

    const mutationCache = queryClient.getMutationCache();
    const refreshMutation = mutationCache.build(
      queryClient,
      pullRequestsForceRefreshMutationOptions(queryClient),
    );
    const actionMutation = mutationCache.build(
      queryClient,
      pullRequestActionMutationOptions(queryClient),
    );
    const refreshPromise = refreshMutation.execute({ state: "open", projectId });
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());

    const actionPromise = actionMutation.execute({ ...identity, action: "draft" });
    await vi.waitFor(() =>
      expect(
        queryClient.getQueryData<{ entries: Array<{ isDraft: boolean }> }>(listKey),
      ).toMatchObject({ entries: [{ isDraft: true }] }),
    );
    expect(action).not.toHaveBeenCalled();

    refreshGate.resolve({
      viewer: "octocat",
      entries: [{ ...identity, state: "open", isDraft: false, isPinned: false }],
      errors: [],
      repositoryBatches: [],
    });
    await refreshPromise;
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(queryClient.getQueryData(listKey)).toMatchObject({
      entries: [{ isDraft: true }],
    });

    actionGate.resolve({});
    await actionPromise;
  });

  it("stores the forced response and invalidates only its exact-list sibling", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const input = { state: "open", projectId } as const;
    const refreshedKey = pullRequestQueryKeys.list(input);
    const exactSiblingKey = pullRequestsExactInvolvementQueryOptions({
      involvement: "authored",
      ...input,
    }).queryKey;
    const otherStateKey = pullRequestQueryKeys.list({ state: "merged", projectId });
    queryClient.setQueryData(refreshedKey, { entries: [] });
    queryClient.setQueryData(exactSiblingKey as QueryKey, { entries: [] });
    queryClient.setQueryData(otherStateKey, { entries: [] });

    const options = pullRequestsForceRefreshMutationOptions(queryClient);
    if (!options.onMutate || !options.onSuccess) throw new Error("Refresh hooks are missing.");
    expect(options.networkMode).toBe("always");
    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    const fresh = { entries: [{ projectId, repository: "acme/widgets", number: 7 }] };
    await Reflect.apply(options.onSuccess, undefined, [fresh, input, context, undefined]);

    expect(queryClient.getQueryData(refreshedKey)).toEqual(fresh);
    expect(queryClient.getQueryState(refreshedKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(exactSiblingKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherStateKey)?.isInvalidated).toBe(false);
  });

  it("preserves a pin started before refresh even when it settles before a stale response", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const input = { state: "open", projectId } as const;
    const refreshedKey = pullRequestQueryKeys.list(input);
    const identity = { projectId, repository: "acme/widgets", number: 42 } as const;
    queryClient.setQueryData(refreshedKey, {
      entries: [{ ...identity, title: "old", isPinned: false }],
    });
    const pinInput = { ...identity, isPinned: true } as const;
    const refreshOptions = pullRequestsForceRefreshMutationOptions(queryClient);
    const pinOptions = pullRequestSetPinnedMutationOptions(queryClient);
    if (
      !refreshOptions.onMutate ||
      !refreshOptions.onSuccess ||
      !pinOptions.onMutate ||
      !pinOptions.onSuccess ||
      !pinOptions.onSettled
    ) {
      throw new Error("Mutation hooks are missing.");
    }

    // Regression order: pin starts, refresh starts, pin succeeds/settles, then the refresh's
    // older response arrives. The refresh may update other fields but cannot undo the pin.
    const pinContext = await Reflect.apply(pinOptions.onMutate, undefined, [pinInput, undefined]);
    const refreshContext = await Reflect.apply(refreshOptions.onMutate, undefined, [
      input,
      undefined,
    ]);
    await Reflect.apply(pinOptions.onSuccess, undefined, [
      pinInput,
      pinInput,
      pinContext,
      undefined,
    ]);
    Reflect.apply(pinOptions.onSettled, undefined, [
      pinInput,
      null,
      pinInput,
      pinContext,
      undefined,
    ]);
    await Reflect.apply(refreshOptions.onSuccess, undefined, [
      { entries: [{ ...identity, title: "fresh", isPinned: false }] },
      input,
      refreshContext,
      undefined,
    ]);

    expect(queryClient.getQueryData(refreshedKey)).toEqual({
      entries: [{ ...identity, title: "fresh", isPinned: true }],
    });
  });

  it("preserves a pin that begins while refresh is in flight", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const input = { state: "open", projectId } as const;
    const refreshedKey = pullRequestQueryKeys.list(input);
    const identity = { projectId, repository: "acme/widgets", number: 42 } as const;
    queryClient.setQueryData(refreshedKey, {
      entries: [{ ...identity, isPinned: false }],
    });
    const refreshOptions = pullRequestsForceRefreshMutationOptions(queryClient);
    const pinOptions = pullRequestSetPinnedMutationOptions(queryClient);
    if (!refreshOptions.onMutate || !refreshOptions.onSuccess || !pinOptions.onMutate) {
      throw new Error("Mutation hooks are missing.");
    }

    const refreshContext = await Reflect.apply(refreshOptions.onMutate, undefined, [
      input,
      undefined,
    ]);
    await Reflect.apply(pinOptions.onMutate, undefined, [
      { ...identity, isPinned: true },
      undefined,
    ]);
    await Reflect.apply(refreshOptions.onSuccess, undefined, [
      { entries: [{ ...identity, isPinned: false }] },
      input,
      refreshContext,
      undefined,
    ]);

    expect(queryClient.getQueryData(refreshedKey)).toEqual({
      entries: [{ ...identity, isPinned: true }],
    });
  });

  it("does not resurrect a reconciled out-of-cap row from a stale forced snapshot", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-refresh-membership" as ProjectId;
    const input = { state: "open", projectId } as const;
    const refreshedKey = pullRequestQueryKeys.list(input);
    const identity = { projectId, repository: "acme/widgets", number: 99 } as const;
    queryClient.setQueryData(refreshedKey, {
      entries: [{ ...identity, isPinned: true }],
    });
    const refreshOptions = pullRequestsForceRefreshMutationOptions(queryClient);
    const pinOptions = pullRequestSetPinnedMutationOptions(queryClient);
    if (
      !refreshOptions.onMutate ||
      !refreshOptions.onSuccess ||
      !pinOptions.onMutate ||
      !pinOptions.onSuccess ||
      !pinOptions.onSettled
    ) {
      throw new Error("Mutation hooks are missing.");
    }

    const refreshContext = await Reflect.apply(refreshOptions.onMutate, undefined, [
      input,
      undefined,
    ]);
    const unpin = { ...identity, isPinned: false } as const;
    const pinContext = await Reflect.apply(pinOptions.onMutate, undefined, [unpin, undefined]);
    await Reflect.apply(pinOptions.onSuccess, undefined, [unpin, unpin, pinContext, undefined]);
    await Reflect.apply(pinOptions.onSettled, undefined, [
      unpin,
      null,
      unpin,
      pinContext,
      undefined,
    ]);
    // The pin's targeted refetch has already established that this recovered-only row no longer
    // belongs in the list. The older manual refresh must preserve that absence.
    queryClient.setQueryData(refreshedKey, { entries: [] });

    await Reflect.apply(refreshOptions.onSuccess, undefined, [
      { entries: [{ ...identity, isPinned: true }] },
      input,
      refreshContext,
      undefined,
    ]);

    expect(queryClient.getQueryData(refreshedKey)).toEqual({ entries: [] });
  });

  it("does not resurrect a fully unpinned aggregate out-of-cap row", async () => {
    const queryClient = new QueryClient();
    const projectA = "project-refresh-membership-a" as ProjectId;
    const projectB = "project-refresh-membership-b" as ProjectId;
    const input = { state: "open", projectId: null } as const;
    const refreshedKey = pullRequestQueryKeys.list(input);
    const staleEntry = {
      projectId: projectA,
      projectTitle: "Project A",
      repository: "acme/widgets",
      number: 99,
      isPinned: true,
      projectContexts: [
        { projectId: projectA, projectTitle: "Project A", isPinned: true },
        { projectId: projectB, projectTitle: "Project B", isPinned: true },
      ],
    };
    queryClient.setQueryData(refreshedKey, { entries: [staleEntry] });
    const refreshOptions = pullRequestsForceRefreshMutationOptions(queryClient);
    const pinOptions = pullRequestSetPinnedMutationOptions(queryClient);
    if (
      !refreshOptions.onMutate ||
      !refreshOptions.onSuccess ||
      !pinOptions.onMutate ||
      !pinOptions.onSuccess ||
      !pinOptions.onSettled
    ) {
      throw new Error("Mutation hooks are missing.");
    }

    const refreshContext = await Reflect.apply(refreshOptions.onMutate, undefined, [
      input,
      undefined,
    ]);
    for (const projectId of [projectA, projectB]) {
      const unpin = {
        projectId,
        repository: staleEntry.repository,
        number: staleEntry.number,
        isPinned: false,
      } as const;
      const pinContext = await Reflect.apply(pinOptions.onMutate, undefined, [unpin, undefined]);
      await Reflect.apply(pinOptions.onSuccess, undefined, [unpin, unpin, pinContext, undefined]);
      await Reflect.apply(pinOptions.onSettled, undefined, [
        unpin,
        null,
        unpin,
        pinContext,
        undefined,
      ]);
    }
    queryClient.setQueryData(refreshedKey, { entries: [] });

    await Reflect.apply(refreshOptions.onSuccess, undefined, [
      { entries: [staleEntry] },
      input,
      refreshContext,
      undefined,
    ]);

    expect(queryClient.getQueryData(refreshedKey)).toEqual({ entries: [] });
  });

  it("does not remove a newly pinned out-of-cap row when an older refresh settles", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-refresh-new-pin" as ProjectId;
    const input = { state: "open", projectId } as const;
    const refreshedKey = pullRequestQueryKeys.list(input);
    const identity = { projectId, repository: "acme/widgets", number: 99 } as const;
    queryClient.setQueryData(refreshedKey, { entries: [] });
    const refreshOptions = pullRequestsForceRefreshMutationOptions(queryClient);
    const pinOptions = pullRequestSetPinnedMutationOptions(queryClient);
    if (
      !refreshOptions.onMutate ||
      !refreshOptions.onSuccess ||
      !pinOptions.onMutate ||
      !pinOptions.onSuccess ||
      !pinOptions.onSettled
    ) {
      throw new Error("Mutation hooks are missing.");
    }

    const refreshContext = await Reflect.apply(refreshOptions.onMutate, undefined, [
      input,
      undefined,
    ]);
    const pin = { ...identity, isPinned: true } as const;
    const pinContext = await Reflect.apply(pinOptions.onMutate, undefined, [pin, undefined]);
    await Reflect.apply(pinOptions.onSuccess, undefined, [pin, pin, pinContext, undefined]);
    await Reflect.apply(pinOptions.onSettled, undefined, [pin, null, pin, pinContext, undefined]);
    // Simulate the pin mutation's targeted reconciliation recovering a row omitted by the cap.
    queryClient.setQueryData(refreshedKey, {
      entries: [{ ...identity, title: "recovered", isPinned: true }],
    });

    await Reflect.apply(refreshOptions.onSuccess, undefined, [
      { entries: [] },
      input,
      refreshContext,
      undefined,
    ]);

    expect(queryClient.getQueryData(refreshedKey)).toEqual({
      entries: [{ ...identity, title: "recovered", isPinned: true }],
    });
  });
});
