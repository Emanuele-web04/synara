// FILE: EnvironmentLocalServersSection.tsx
// Purpose: Environment panel row/menu for active local dev servers with one-click stop actions.
// Layer: Environment panel section
// Depends on: server local-server React Query helpers and the shared Environment row skin.

import type { ReactNode } from "react";

import type { ServerLocalServerProcess } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { localServerPrimaryLabel } from "@synara/shared/localServers";

import { LocalServerIdentity } from "../../LocalServerIdentity";
import { ComposerPickerMenuPopup } from "../ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuTrigger } from "../../ui/menu";
import { GlobeIcon, RefreshCwIcon, StopFilledIcon } from "~/lib/icons";
import {
  serverLocalServersQueryOptions,
  serverStopLocalServerMutationOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./EnvironmentRow";

function describeServerCount(count: number): string {
  if (count === 0) return "No servers running";
  return `${count} server${count === 1 ? "" : "s"} running`;
}

/** Compact, non-closing icon action used for the menu's Refresh affordance. */
function LocalServersRefreshButton({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <MenuItem
      closeOnClick={false}
      disabled={refreshing}
      onClick={onRefresh}
      aria-label="Refresh local servers"
      title="Refresh"
      className="inline-flex size-5 items-center justify-center rounded-md p-0 text-muted-foreground/60 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-highlighted:text-[var(--color-text-foreground)]"
    >
      <RefreshCwIcon className={cn("size-3", refreshing && "animate-spin")} />
    </MenuItem>
  );
}

/**
 * A single running server: status dot, name, and its `localhost:<port>` address,
 * plus a compact stop control. Only the stop button is interactive (and the only
 * red accent), so the row itself stays clean — no row-wide highlight. The right
 * padding keeps the stop button clear of the popup's overlay scrollbar.
 */
function LocalServerRow({
  server,
  stopping,
  onStop,
}: {
  server: ServerLocalServerProcess;
  stopping: boolean;
  onStop: (server: ServerLocalServerProcess) => void;
}) {
  const stoppable = server.isStoppable && !stopping;
  const primaryLabel = localServerPrimaryLabel(server);
  const stopHint = server.isStoppable
    ? `Stop ${primaryLabel}`
    : (server.stopDisabledReason ?? server.args ?? server.displayName);

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[0.5rem] py-1 pl-2 pr-3">
      {/* Running indicator: a soft-haloed dot so an active server reads at a glance. */}
      <span className="relative flex size-2 shrink-0 items-center justify-center" aria-hidden>
        <span className="absolute size-2 rounded-full bg-success/25" />
        <span className="relative size-1 rounded-full bg-success" />
      </span>

      <LocalServerIdentity server={server} tone="menu" />

      <MenuItem
        closeOnClick={false}
        disabled={!stoppable}
        onClick={() => onStop(server)}
        aria-label={stopHint}
        title={stopHint}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-[var(--color-background-elevated-secondary)] p-0 text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] hover:text-destructive data-highlighted:border-destructive/40 data-highlighted:bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] data-highlighted:text-destructive data-disabled:border-border/40 data-disabled:bg-transparent data-disabled:text-muted-foreground/30 data-disabled:hover:bg-transparent data-disabled:hover:text-muted-foreground/30"
      >
        {stopping ? (
          <RefreshCwIcon className="size-3.5 animate-spin" />
        ) : (
          <StopFilledIcon className="size-3.5" />
        )}
      </MenuItem>
    </div>
  );
}

/** Centered placeholder for loading / error / empty states inside the menu body. */
function LocalServersPlaceholder({
  icon,
  title,
  subtitle,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1 px-3 py-3 text-center">
      <span className="text-muted-foreground/40">{icon}</span>
      <span className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
        {title}
      </span>
      {subtitle ? (
        <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/60">
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}

export function EnvironmentLocalServersSection({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const localServersQuery = useQuery(serverLocalServersQueryOptions(enabled));
  const stopLocalServerMutation = useMutation(
    serverStopLocalServerMutationOptions({ queryClient }),
  );

  const servers = localServersQuery.data?.servers ?? [];
  const serverCount = servers.length;
  const isBusy = localServersQuery.isFetching || stopLocalServerMutation.isPending;
  const activeStoppingPid = stopLocalServerMutation.variables?.pid ?? null;

  const trailing = (
    <>
      {isBusy ? (
        <RefreshCwIcon className="size-3 animate-spin text-[var(--color-text-foreground-secondary)]" />
      ) : (
        <span className="flex items-center gap-1.5">
          {serverCount > 0 ? (
            <span className="size-1.5 rounded-full bg-success" aria-hidden />
          ) : null}
          <span className="text-[11px] tabular-nums text-[var(--color-text-foreground-secondary)]">
            {serverCount}
          </span>
        </span>
      )}
      <EnvironmentRowChevron />
    </>
  );

  return (
    <Menu>
      <MenuTrigger render={<button type="button" className={ENVIRONMENT_ROW_CLASS_NAME} />}>
        <EnvironmentRowBody
          icon={<GlobeIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label="Local Servers"
          trailing={trailing}
        />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="bottom" className="w-72 min-w-72">
        <div className="flex items-center justify-between gap-2 pb-0.5 pl-2 pr-3 pt-px">
          <span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] font-normal text-muted-foreground/50">
            {localServersQuery.isLoading ? "Scanning ports…" : describeServerCount(serverCount)}
          </span>
          <LocalServersRefreshButton
            refreshing={localServersQuery.isFetching}
            onRefresh={() => void localServersQuery.refetch()}
          />
        </div>

        {localServersQuery.isLoading ? (
          <LocalServersPlaceholder
            icon={<RefreshCwIcon className="size-4 animate-spin" />}
            title="Scanning local ports"
          />
        ) : localServersQuery.isError ? (
          <LocalServersPlaceholder
            icon={<GlobeIcon className="size-4" />}
            title="Couldn't scan local ports"
            subtitle={
              localServersQuery.error instanceof Error
                ? localServersQuery.error.message
                : "The scan failed. Try refreshing."
            }
          />
        ) : serverCount === 0 ? (
          <LocalServersPlaceholder
            icon={<GlobeIcon className="size-4" />}
            title="No servers running"
            subtitle="Local dev servers will appear here."
          />
        ) : (
          <div className="flex flex-col gap-0.5">
            {servers.map((server) => (
              <LocalServerRow
                key={server.id}
                server={server}
                stopping={activeStoppingPid === server.pid && stopLocalServerMutation.isPending}
                onStop={(selectedServer) =>
                  stopLocalServerMutation.mutate({
                    pid: selectedServer.pid,
                    port: selectedServer.ports[0] ?? 1,
                  })
                }
              />
            ))}
          </div>
        )}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
