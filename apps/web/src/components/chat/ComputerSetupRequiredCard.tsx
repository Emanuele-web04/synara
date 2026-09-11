// FILE: ComputerSetupRequiredCard.tsx
// Purpose: Shows the current desktop permission state and an explicit setup action.
// Layer: Chat transcript UI

import { useQuery } from "@tanstack/react-query";
import { useProvisionComputer } from "~/hooks/useProvisionComputer";
import { useRefreshOnWindowReturn } from "~/hooks/useRefreshOnWindowReturn";
import { DesktopPermissionSetup } from "../settings/DesktopPermissionSetup";
import {
  computerStatusQueryOptions,
  COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS,
} from "~/lib/serverReactQuery";
import {
  computerPermissionGrants,
  computerStatusNeedsSetup,
  resolveComputerAvailabilityView,
} from "../ComputerPanel.logic";
import type {
  ComputerBuildSignature,
  ComputerPermission,
  ComputerStatusResult,
} from "@synara/contracts";
import {
  computerStaleGrantAdvice,
  listComputerPermissions,
} from "@synara/shared/computerPermissions";

import { Button } from "~/components/ui/button";
import { MonitorIcon } from "~/lib/icons";

export function ComputerSetupRequiredCard({
  missing,
  buildSignature,
  bundleId,
  computerControlReady,
  status,
  statusError,
  isPending = false,
  textFontSizePx,
  metaFontSizePx,
  onSetUp,
  onRecheck,
}: {
  /**
   * The grants the OS is withholding. Naming them is most of this card's value:
   * "a permission Synara needs" sends the user hunting through Privacy &
   * Security, while "Accessibility" tells them exactly which switch to find.
   * Empty when the backend refused without naming one.
   */
  readonly missing?: readonly ComputerPermission[];
  /**
   * How this Synara is signed. On a locally built copy the missing grant may be
   * one macOS still lists as given — pinned to a binary a rebuild replaced —
   * which is the difference between "grant it" and "the switch lies to you".
   */
  readonly buildSignature?: ComputerBuildSignature;
  /**
   * The app macOS files this Synara's grants against, as the server reported it.
   * The stale-grant advice names it in a `tccutil reset`, and there is no safe
   * default: the `.dev` and `.canary` flavors are separate bundle identifiers,
   * so guessing the released one hands the user a command that revokes a
   * different Synara's working permissions. Absent means the advice omits the
   * command entirely.
   */
  readonly bundleId?: string;
  // Live setup state, derived from the desktop's current availability rather
  // than remembered from a button press: once the grants land — including when
  // the user simply allows the dialog macOS already showed — the card flips to a
  // confirmation instead of offering a button that would do nothing.
  readonly computerControlReady?: boolean;
  readonly status?: ComputerStatusResult;
  readonly statusError?: string;
  readonly isPending?: boolean;
  readonly textFontSizePx?: number;
  readonly metaFontSizePx?: number;
  readonly onSetUp?: () => void;
  readonly onRecheck?: () => void;
}) {
  const ready =
    !statusError &&
    (status
      ? status.availability.kind === "available" &&
        status.health.status === "connected" &&
        !computerStatusNeedsSetup(status)
      : computerControlReady === true);
  const availability = status?.availability;
  const livePermission = availability?.kind === "permission-required" ? availability : undefined;
  const currentMissing = statusError
    ? []
    : status
      ? (livePermission?.missing ?? [])
      : (missing ?? []);
  const missingLabels = listComputerPermissions(currentMissing);
  const currentSignature = status ? livePermission?.buildSignature : buildSignature;
  const currentBundleId = status ? livePermission?.bundleId : bundleId;
  const availabilityView = status
    ? resolveComputerAvailabilityView(status.availability, status.health)
    : undefined;
  const title = statusError
    ? "Computer status is unavailable"
    : ready
      ? "Computer control is ready"
      : missingLabels
        ? `Computer control needs ${missingLabels}`
        : (availabilityView?.title ?? "Computer control needs setup");
  const description = statusError
    ? statusError
    : ready
      ? "Send a message and the agent will pick up where it left off."
      : missingLabels
        ? "Choose Set up to request missing permissions or open System Settings. Allow access for this Synara app, then return here to recheck."
        : (availabilityView?.description ??
          "Choose Set up to check permissions and prepare computer control.");
  const canSetUp =
    !ready &&
    !statusError &&
    availability?.kind !== "unsupported-platform" &&
    status?.provisionable !== false;
  // Only ever non-null on a locally built copy with a grant outstanding: on a
  // signed build the switch in System Settings means what it says, and the
  // extra paragraph would be a red herring.
  const staleGrantAdvice =
    !ready && currentSignature
      ? computerStaleGrantAdvice(currentMissing, currentSignature, currentBundleId)
      : null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] px-3 py-2.5">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] text-amber-500">
        <MonitorIcon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className="truncate font-medium text-[var(--color-text-foreground)]"
          style={textFontSizePx ? { fontSize: `${textFontSizePx}px` } : undefined}
        >
          {title}
        </p>
        <p
          className="text-[var(--color-text-foreground-secondary)]"
          style={metaFontSizePx ? { fontSize: `${metaFontSizePx}px` } : undefined}
        >
          {description}
        </p>
        {staleGrantAdvice ? (
          <p
            className="mt-1 text-[var(--color-text-foreground-secondary)]"
            style={metaFontSizePx ? { fontSize: `${metaFontSizePx}px` } : undefined}
          >
            {staleGrantAdvice}
          </p>
        ) : null}
      </div>
      {onSetUp && canSetUp ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={isPending}
          onClick={onSetUp}
        >
          {isPending ? "Setting up…" : "Set up"}
        </Button>
      ) : statusError && onRecheck ? (
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onRecheck}>
          Recheck
        </Button>
      ) : null}
    </div>
  );
}

/** The desktop is shared, so setup status is independent of the selected chat. */
export function ConnectedComputerSetupRequiredCard(
  props: Parameters<typeof ComputerSetupRequiredCard>[0],
) {
  const statusQuery = useQuery({
    ...computerStatusQueryOptions(),
    refetchInterval: COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS,
  });
  const status = statusQuery.data;
  useRefreshOnWindowReturn(() => statusQuery.refetch({ cancelRefetch: false }));
  const missing = status
    ? status.availability.kind === "permission-required"
      ? status.availability.missing
      : []
    : props.missing;
  const setup = useProvisionComputer({
    ...(missing ? { missing } : {}),
    notify: true,
  });
  return (
    <div className="space-y-2">
      <ComputerSetupRequiredCard
        {...props}
        {...(status ? { status } : {})}
        {...(statusQuery.isError
          ? {
              statusError:
                statusQuery.error instanceof Error && statusQuery.error.message
                  ? statusQuery.error.message
                  : "Could not check computer access. Try again.",
            }
          : {})}
        isPending={setup.isPending}
        onSetUp={setup.provision}
        onRecheck={() => void statusQuery.refetch()}
      />
      {window.desktopBridge?.permissions ? (
        <DesktopPermissionSetup
          feature="computer"
          grants={computerPermissionGrants(statusQuery.isError ? undefined : status)}
        />
      ) : null}
    </div>
  );
}
