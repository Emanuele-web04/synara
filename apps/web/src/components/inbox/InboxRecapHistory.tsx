import type { SavedInboxRecap, StatsGetRecapResult } from "@synara/contracts";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useAccount } from "~/hooks/useAccount";
import { ensureNativeApi } from "~/nativeApi";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { readHostsApi } from "~/lib/hosts/api";
import { useAccountDialogStore } from "~/components/account/accountDialogStore";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";

type HistoryProps = {
  recap: StatsGetRecapResult | undefined;
  renderRecap: (saved: SavedInboxRecap) => ReactNode;
};

export function InboxRecapHistory(props: HistoryProps) {
  const { status } = useAccount();
  const openSignIn = useAccountDialogStore((store) => store.openSignIn);
  if (status?.state !== "signed-in") {
    return (
      <div className="flex items-center justify-between gap-3 text-ui-sm text-muted-foreground">
        <span>Sign in to automatically save private recaps across your devices.</span>
        <Button variant="outline" size="sm" onClick={openSignIn}>
          Sign in
        </Button>
      </div>
    );
  }
  const scope = JSON.stringify([status.accountAuthority, status.me.id, status.me.organization.id]);
  // Remount on account/workspace changes so mutation messages cannot survive an identity switch.
  return (
    <PrivateRecapHistory
      key={scope}
      {...props}
      scope={scope}
      expectedUserId={status.me.id}
      expectedOrganizationId={status.me.organization.id}
    />
  );
}

function PrivateRecapHistory({
  recap,
  renderRecap,
  scope,
  expectedUserId,
  expectedOrganizationId,
}: HistoryProps & { scope: string; expectedUserId: string; expectedOrganizationId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const queryKey = ["account", "inboxRecaps", scope] as const;
  const history = useInfiniteQuery({
    queryKey,
    enabled: open,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      ensureNativeApi().account.listInboxRecaps({
        limit: 20,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 30_000,
    retry: 1,
  });
  const save = useMutation({
    mutationFn: async () => {
      if (!recap) throw new Error("Load a recap before saving it.");
      const api = ensureNativeApi();
      const context = readExecutionContext();
      const hostsApi = readHostsApi();
      const sourceHostId =
        context?.remoteHostId ?? (hostsApi ? (await hostsApi.enrollment()).host?.id : undefined);
      if (!sourceHostId)
        throw new Error("Link this computer to your account before saving a recap.");
      const start = new Date(recap.totals.from);
      const day = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
      return api.account.saveInboxRecap({
        expectedUserId,
        expectedOrganizationId,
        request: {
          sourceHostId,
          day,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          recap,
        },
      });
    },
    onSuccess: () => {
      setOpen(true);
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => ensureNativeApi().account.deleteInboxRecap({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const recaps = history.data?.pages.flatMap((page) => page.recaps) ?? [];
  // A save during pagination may move a row between pages; render its latest occurrence once.
  const seenIds = new Set<string>();
  const uniqueRecaps = recaps.filter((item) => {
    if (seenIds.has(item.id)) return false;
    seenIds.add(item.id);
    return true;
  });
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CollapsibleTrigger className="text-ui font-medium">
          Saved recaps {open ? "−" : "+"}
        </CollapsibleTrigger>
        <Button
          variant="outline"
          size="sm"
          disabled={!recap || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save privately"}
        </Button>
      </div>
      <p className="text-ui-sm text-muted-foreground">
        Your signed-in computer automatically saves recaps, including project names, to your private
        account. Save privately updates this day now. Saved history stays available when this
        computer is offline.
      </p>
      {save.isSuccess ? (
        <p role="status" className="text-ui-sm text-status-success">
          Recap saved to your account.
        </p>
      ) : null}
      {save.isError || remove.isError ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {save.error?.message ?? remove.error?.message ?? "The saved recap could not be updated."}
        </p>
      ) : null}
      <CollapsiblePanel className="flex flex-col gap-3">
        {history.isPending ? (
          <p className="text-ui-sm text-muted-foreground">Loading saved recaps…</p>
        ) : null}
        {history.isError ? (
          <div className="flex items-center justify-between gap-3 text-ui-sm">
            <span>Saved recaps could not be loaded.</span>
            <Button variant="outline" size="xs" onClick={() => void history.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}
        {history.isSuccess && uniqueRecaps.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground">No saved recaps yet.</p>
        ) : null}
        {uniqueRecaps.map((saved) => (
          <Collapsible key={saved.id} className="rounded-2xl border border-border p-4">
            <div className="flex items-center justify-between gap-3">
              <CollapsibleTrigger className="min-w-0 text-left text-ui">
                {saved.day} · {saved.sourceHostName}
                <span className="block text-ui-xs text-muted-foreground">
                  {saved.timezone} · saved {new Date(saved.savedAt).toLocaleString()}
                </span>
              </CollapsibleTrigger>
              <Button
                variant="ghost"
                size="xs"
                disabled={remove.isPending}
                onClick={() => remove.mutate(saved.id)}
              >
                Delete
              </Button>
            </div>
            <CollapsiblePanel className="pt-4">{renderRecap(saved)}</CollapsiblePanel>
          </Collapsible>
        ))}
        {history.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? "Loading…" : "Load older recaps"}
          </Button>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}
