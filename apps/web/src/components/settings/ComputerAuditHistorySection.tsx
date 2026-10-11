import {
  COMPUTER_AUDIT_HISTORY_MAX_LIMIT,
  type ComputerAuditHistoryEntry,
  type ComputerGetAuditHistoryResult,
} from "@synara/contracts";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { describeComputerToolCall } from "~/lib/computerToolPresentation";
import { ComputerUseIcon } from "~/lib/icons";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Button } from "~/components/ui/button";
import { SettingsCard, SettingsListRow, SettingsSectionShell } from "./SettingsPanelPrimitives";

const PAGE_SIZE = 30;
const EFFECT_LABELS: Record<ComputerAuditHistoryEntry["effect"], string> = {
  verified: "Effect observed",
  "dispatched-unknown": "Sent; effect unconfirmed",
  "not-dispatched": "Not sent",
  refused: "Blocked",
  error: "Failed",
};

type AuditPage = { readonly before?: string; readonly limit: number };

export function nextComputerAuditHistoryPage(
  last: ComputerGetAuditHistoryResult,
  pages: readonly ComputerGetAuditHistoryResult[],
): AuditPage | undefined {
  const remaining =
    COMPUTER_AUDIT_HISTORY_MAX_LIMIT -
    pages.reduce((count, page) => count + page.entries.length, 0);
  if (!last.nextCursor || remaining <= 0) return undefined;
  return { before: last.nextCursor, limit: Math.min(PAGE_SIZE, remaining) };
}

export function computerAuditHistoryEntries(
  pages: readonly ComputerGetAuditHistoryResult[],
): readonly ComputerAuditHistoryEntry[] {
  return [
    ...new Map(pages.flatMap((page) => page.entries).map((entry) => [entry.id, entry])).values(),
  ].slice(0, COMPUTER_AUDIT_HISTORY_MAX_LIMIT);
}

/** No polling: history is read only after the user opens it, and refreshed on request. */
export function ComputerAuditHistorySection() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const history = useInfiniteQuery({
    queryKey: serverQueryKeys.computerAuditHistory(),
    initialPageParam: { limit: PAGE_SIZE } as AuditPage,
    queryFn: ({ pageParam }) => ensureNativeApi().computer.getAuditHistory(pageParam),
    getNextPageParam: nextComputerAuditHistoryPage,
    enabled: open,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const pages = history.data?.pages ?? [];
  const entries = computerAuditHistoryEntries(pages);
  const truncated = pages.some((page) => page.truncated);
  const status = pages[0]?.status;
  const refresh = () => {
    void queryClient.resetQueries({
      queryKey: serverQueryKeys.computerAuditHistory(),
      exact: true,
    });
  };

  return (
    <SettingsSectionShell
      title="Recent Computer actions"
      action={
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <DisclosureChevron open={open} />
          {open ? "Hide history" : "Show history"}
        </Button>
      }
    >
      <DisclosureRegion open={open}>
        {open ? (
          <div className="space-y-3">
            <p className="px-2 text-ui-sm text-muted-foreground">
              Recent actions across chats on this server. Read-only observations, typed text, page
              contents, and file paths are not included.
            </p>
            {history.isPending ? (
              <p className="px-2 text-ui-sm text-muted-foreground" role="status">
                Loading recent actions…
              </p>
            ) : null}
            {history.isError ? (
              <p className="px-2 text-ui-sm text-destructive" role="alert">
                Could not load recent actions. Refresh to try again.
              </p>
            ) : null}
            {status ? (
              <ComputerAuditHistoryList entries={entries} status={status} truncated={truncated} />
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs" variant="outline" disabled={history.isFetching} onClick={refresh}>
                Refresh history
              </Button>
              {history.hasNextPage && !history.isError ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={history.isFetching}
                  onClick={() => void history.fetchNextPage()}
                >
                  {history.isFetchingNextPage ? "Loading…" : "Load older actions"}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </DisclosureRegion>
    </SettingsSectionShell>
  );
}

export function ComputerAuditHistoryList(props: {
  readonly entries: readonly ComputerAuditHistoryEntry[];
  readonly status: ComputerGetAuditHistoryResult["status"];
  readonly truncated: boolean;
}) {
  return (
    <>
      {props.entries.length > 0 ? (
        <div role="list" aria-label="Recent Computer actions">
          <SettingsCard>
            {props.entries.map((entry) => (
              <div role="listitem" key={entry.id}>
                <SettingsListRow
                  title={
                    <span className="flex items-center gap-2">
                      <ComputerUseIcon className="size-4 shrink-0" />
                      {describeComputerToolCall({ toolName: entry.tool, args: undefined })
                        ?.summary ?? "Computer action"}
                    </span>
                  }
                  description={
                    <time dateTime={entry.ts}>{new Date(entry.ts).toLocaleString()}</time>
                  }
                  actions={
                    <span className="text-ui-xs text-muted-foreground">
                      {EFFECT_LABELS[entry.effect]}
                    </span>
                  }
                />
              </div>
            ))}
          </SettingsCard>
        </div>
      ) : (
        <p className="px-2 text-ui-sm text-muted-foreground">
          {props.status === "disabled"
            ? "Action history is not enabled on this server."
            : props.truncated
              ? "Older retained actions are no longer available. Refresh to see recent actions."
              : "No recorded actions yet."}
        </p>
      )}
      {props.truncated && props.entries.length > 0 ? (
        <p className="px-2 text-ui-sm text-muted-foreground">
          Some earlier actions are unavailable. This is not a complete history.
        </p>
      ) : null}
      {props.entries.length >= COMPUTER_AUDIT_HISTORY_MAX_LIMIT ? (
        <p className="px-2 text-ui-sm text-muted-foreground">
          Showing the latest {COMPUTER_AUDIT_HISTORY_MAX_LIMIT} loaded actions.
        </p>
      ) : null}
    </>
  );
}
