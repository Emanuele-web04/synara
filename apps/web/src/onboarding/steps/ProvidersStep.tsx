// FILE: ProvidersStep.tsx
// Purpose: Agents step of the onboarding: a full-bleed grid with one cell per runtime,
//          its detection status, an enable/disable switch bound to the server-backed
//          `disabledProviders` setting, inline sign-in for detected-but-unauthenticated
//          CLIs, and a setup-guide link for missing ones.
// Layer: Web UI component

import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { VISIBLE_PROVIDER_DESCRIPTORS } from "../../betaFeatures";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { getCustomBinaryPathForProvider, useAppSettings } from "~/appSettings";
import { ProviderIcon } from "~/components/ProviderIcon";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Skeleton } from "~/components/ui/skeleton";
import { StatusDot } from "~/components/ui/status-chip";
import { Switch } from "~/components/ui/switch";
import { ChevronRightIcon, RefreshCwIcon, XIcon } from "~/lib/icons";
import {
  findProviderStatus,
  normalizeProviderStatusForLocalConfig,
} from "~/lib/providerAvailability";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";
import { isProviderKind } from "~/providerOrdering";
import { useWorkspacePathsStore } from "~/workspacePathsStore";
import { classifyProviderSetup, summarizeProviderSetup, type ProviderSetupState } from "../logic";
import type { ProviderDetection } from "../useProviderDetection";
import { ONBOARDING_LIVE_COLOR } from "../stage/stageTokens";
import { ProviderConnectTerminal } from "./ProviderConnectTerminal";

const EMPTY_STATUSES: readonly ServerProviderStatus[] = [];

/** Status as a dot + word; the dot carries the colour, the copy stays muted. */
const STATE_PRESENTATION: Record<ProviderSetupState, { label: string; dotClassName: string }> = {
  connected: { label: "chat:connected", dotClassName: "bg-[#317CFF]" },
  "needs-sign-in": { label: "common:needsSignIn", dotClassName: "bg-warning" },
  "not-installed": { label: "onboarding:notInstalled", dotClassName: "bg-muted-foreground/40" },
  detecting: { label: "onboarding:detecting", dotClassName: "bg-muted-foreground/40" },
  "check-failed": { label: "onboarding:couldNotCheck", dotClassName: "bg-warning" },
  disabled: { label: "chat:disabled", dotClassName: "bg-muted-foreground/40" },
};

const CELL_ACTION_CLASS_NAME =
  "inline-flex cursor-pointer items-center gap-0.5 text-ui-sm transition-opacity hover:opacity-75 motion-reduce:transition-none";

/**
 * Raw detection statuses with custom-binary overrides applied but *without* folding the
 * disabled flag in: this step must keep showing "installed" for a provider the user just
 * unchecked, otherwise the card appears to lose its CLI.
 */
function useDetectedProviderStatuses(): readonly ServerProviderStatus[] {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const providers = serverConfigQuery.data?.providers ?? EMPTY_STATUSES;
  return useMemo(
    () =>
      providers.flatMap((status) => {
        const provider = status.driver ?? status.provider;
        if (!isProviderKind(provider) || (status.instanceId ?? status.provider) !== provider) {
          return [];
        }
        const normalized = normalizeProviderStatusForLocalConfig({
          provider,
          status,
          customBinaryPath: getCustomBinaryPathForProvider(settings, provider),
        });
        return normalized ? [normalized] : [];
      }),
    [providers, settings],
  );
}

/**
 * Optimistic disabled-provider selection. `disabledProviders` is server-owned and is not
 * applied to local settings until the round-trip completes, so deriving each write from
 * `settings.disabledProviders` would let a second toggle rebuild the list without the
 * first change. Every write instead comes from this draft, and the draft only resyncs
 * from the server once no write is in flight (e.g. after a failed request is rolled back).
 */
function useDisabledProvidersDraft(): {
  readonly disabled: ReadonlySet<ProviderKind>;
  readonly setProviderDisabled: (provider: ProviderKind, disabled: boolean) => void;
} {
  const { settings, updateSettingsAndWait } = useAppSettings();
  const [draft, setDraft] = useState<ReadonlySet<ProviderKind>>(
    () => new Set(settings.disabledProviders),
  );
  const draftRef = useRef(draft);
  // State, not a ref: a rejected write refetches settings *before* the count drops, so the
  // resync must run again once the final write settles or the draft would stay rolled
  // forward on the rejected value.
  const [pendingWrites, setPendingWrites] = useState(0);
  const serverDisabledProviders = settings.disabledProviders;

  useEffect(() => {
    if (pendingWrites > 0) return;
    const next = new Set(serverDisabledProviders);
    draftRef.current = next;
    setDraft(next);
  }, [pendingWrites, serverDisabledProviders]);

  const setProviderDisabled = (provider: ProviderKind, disabled: boolean) => {
    const next = new Set(draftRef.current);
    if (disabled) {
      next.add(provider);
    } else {
      next.delete(provider);
    }
    draftRef.current = next;
    setDraft(next);
    setPendingWrites((count) => count + 1);
    void updateSettingsAndWait({ disabledProviders: [...next] }).finally(() => {
      setPendingWrites((count) => count - 1);
    });
  };

  return { disabled: draft, setProviderDisabled };
}

export function ProvidersStep(props: { readonly detection: ProviderDetection }) {
  const { t } = useTranslation();
  const { detection } = props;
  const statuses = useDetectedProviderStatuses();
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const [connectingProvider, setConnectingProvider] = useState<ProviderKind | null>(null);
  const { disabled: disabledSet, setProviderDisabled } = useDisabledProvidersDraft();

  // Probe once on entry so a CLI installed while the intro was open shows up.
  const refreshedOnEntryRef = useRef(false);
  useEffect(() => {
    if (refreshedOnEntryRef.current) return;
    refreshedOnEntryRef.current = true;
    void detection.detect({ silent: true });
  }, [detection]);

  const rows = VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => {
    const status = findProviderStatus(statuses, descriptor.kind);
    const state = classifyProviderSetup({
      status,
      disabled: disabledSet.has(descriptor.kind),
      detecting: detection.detecting,
      detectionFailed: detection.failed,
    });
    return { descriptor, status, state };
  });
  const summary = summarizeProviderSetup(
    rows.map((row) => ({ provider: row.descriptor.kind, state: row.state })),
  );
  const connecting = connectingProvider
    ? rows.find((row) => row.descriptor.kind === connectingProvider)
    : undefined;
  const connectingSignInCommand = connecting?.descriptor.usage?.signInCommand;

  const finishConnect = () => {
    setConnectingProvider(null);
    void detection.detect({ silent: true });
  };
  const toggleConnect = (provider: ProviderKind) => {
    if (connectingProvider === provider) {
      finishConnect();
      return;
    }
    setConnectingProvider(provider);
  };

  // The terminal mounts below the provider grid in a fixed-height dialog; bring it into
  // view so the sign-in prompt is not left under the scroll fold.
  const terminalRegionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!connectingProvider) return;
    const frame = window.requestAnimationFrame(() => {
      terminalRegionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [connectingProvider]);

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-foreground/8 bg-background px-8 text-ui text-muted-foreground">
        <span aria-live="polite">
          {summary.detecting > 0
            ? t("onboarding:detectingAgentsOnThisMachine")
            : summary.checkFailed > 0
              ? t("onboarding:couldnTCheckAllAgentsTryReDetect")
              : t("onboarding:providerSummary", {
                  connected: summary.connected,
                  needsSignIn: summary.needsSignIn,
                  notInstalled: summary.notInstalled,
                })}
        </span>
        <button
          type="button"
          disabled={detection.detecting}
          className="inline-flex cursor-pointer items-center gap-1.5 text-foreground/70 transition-colors hover:text-foreground disabled:opacity-60 motion-reduce:transition-none"
          onClick={() => void detection.detect()}
        >
          <RefreshCwIcon
            className={cn("size-3.5", detection.detecting && "animate-spin")}
            aria-hidden
          />
          {t("onboarding:reDetect")}
        </button>
      </div>

      <div className="grid flex-1 auto-rows-[minmax(168px,1fr)] grid-cols-2 sm:grid-cols-3 xl:grid-cols-5">
        {rows.map(({ descriptor, status, state }) => {
          const presentation = STATE_PRESENTATION[state];
          const enabled = state !== "disabled";
          const installed = status?.available === true;
          const canConnectInline =
            state === "needs-sign-in" &&
            descriptor.usage?.signInCommand !== undefined &&
            homeDir !== null;
          const isConnecting = connectingProvider === descriptor.kind;
          const switchId = `onboarding-provider-${descriptor.kind}`;
          return (
            <div
              key={descriptor.kind}
              className={cn(
                "-mt-px -ml-px flex flex-col justify-between border border-foreground/8 p-6 transition-colors motion-reduce:transition-none",
                // Opaque, so the landscape behind the stage never shows through the copy.
                installed && enabled
                  ? "bg-popover"
                  : "bg-background shadow-[inset_0_0_0_100vmax_rgb(0_0_0/0.03)] dark:shadow-[inset_0_0_0_100vmax_rgb(255_255_255/0.03)]",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <ProviderIcon
                  provider={descriptor.kind}
                  className={cn("size-7 shrink-0", !(installed && enabled) && "opacity-55")}
                />
                <Switch
                  id={switchId}
                  checked={enabled}
                  aria-label={t(enabled ? "settings:disableProvider" : "settings:enableProvider", {
                    provider: descriptor.displayName,
                  })}
                  onCheckedChange={(checked) => setProviderDisabled(descriptor.kind, !checked)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={switchId}
                  className={cn(
                    "cursor-pointer truncate text-ui-lg",
                    installed && enabled ? "text-foreground" : "text-foreground/60",
                  )}
                >
                  {descriptor.displayName}
                </label>
                <span className="flex h-lh items-center gap-1.5 text-ui-sm text-muted-foreground">
                  {state === "detecting" ? (
                    <>
                      <Skeleton aria-hidden className="h-2.5 w-20 rounded-full" />
                      <span className="sr-only">{t(presentation.label)}</span>
                    </>
                  ) : (
                    <>
                      <StatusDot aria-hidden className={presentation.dotClassName} />
                      {t(presentation.label)}
                    </>
                  )}
                </span>
                <span className="flex h-lh items-center">
                  {canConnectInline ? (
                    <button
                      type="button"
                      className={CELL_ACTION_CLASS_NAME}
                      style={{ color: ONBOARDING_LIVE_COLOR }}
                      onClick={() => toggleConnect(descriptor.kind)}
                    >
                      {isConnecting ? t("git:detail_done") : t("chat:providerModelPicker_signIn")}
                      <ChevronRightIcon className="size-3" aria-hidden />
                    </button>
                  ) : null}
                  {state === "not-installed" ? (
                    <a
                      href={descriptor.setupDocsHref}
                      target="_blank"
                      rel="noreferrer"
                      className={CELL_ACTION_CLASS_NAME}
                      style={{ color: ONBOARDING_LIVE_COLOR }}
                    >
                      {t("computer:setUp")}
                      <ChevronRightIcon className="size-3" aria-hidden />
                    </a>
                  ) : null}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <DisclosureRegion open={connecting !== undefined}>
        {connecting && connectingSignInCommand !== undefined && homeDir !== null ? (
          <div ref={terminalRegionRef} className="flex flex-col gap-1.5 px-8 py-4">
            {/* Always-available close: the card's "Done" link disappears once the
                provider is detected as connected, but the terminal stays mounted. */}
            <div className="flex items-center justify-between text-ui text-muted-foreground">
              <span>
                {t("onboarding:signingInToProvider", {
                  provider: connecting.descriptor.displayName,
                })}{" "}
                · <code className="text-foreground/80">{connectingSignInCommand}</code>
              </span>
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1 text-foreground/70 transition-colors hover:text-foreground motion-reduce:transition-none"
                onClick={finishConnect}
              >
                <XIcon className="size-3.5" aria-hidden />
                {t("git:detail_done")}
              </button>
            </div>
            <ProviderConnectTerminal
              key={connecting.descriptor.kind}
              provider={connecting.descriptor.kind}
              signInCommand={connectingSignInCommand}
              cwd={homeDir}
            />
          </div>
        ) : null}
      </DisclosureRegion>
    </div>
  );
}
