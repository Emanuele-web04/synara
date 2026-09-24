// FILE: ProvidersStep.tsx
// Purpose: Provider grid for the welcome tour: one card per runtime with its detection
//          status, an enable/disable checkbox bound to the server-backed `disabledProviders`
//          setting, inline sign-in for detected-but-unauthenticated CLIs, and a setup-guide
//          link for missing ones.
// Layer: Web UI component

import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { getCustomBinaryPathForProvider, useAppSettings } from "~/appSettings";
import { ProviderIcon } from "~/components/ProviderIcon";
import { Checkbox } from "~/components/ui/checkbox";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Skeleton } from "~/components/ui/skeleton";
import { RefreshCwIcon, XIcon } from "~/lib/icons";
import {
  findProviderStatus,
  normalizeProviderStatusForLocalConfig,
} from "~/lib/providerAvailability";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useWorkspacePathsStore } from "~/workspacePathsStore";
import { ONBOARDING_TILE_CLASS_NAME } from "../layout";
import { classifyProviderSetup, summarizeProviderSetup, type ProviderSetupState } from "../logic";
import type { ProviderDetection } from "../useProviderDetection";
import { ProviderConnectTerminal } from "./ProviderConnectTerminal";

const EMPTY_STATUSES: readonly ServerProviderStatus[] = [];

/** Status as a dot + word; the dot carries the colour, the copy stays muted. */
const STATE_PRESENTATION: Record<ProviderSetupState, { label: string; dotClassName: string }> = {
  connected: { label: "Connected", dotClassName: "bg-status-success" },
  "needs-sign-in": { label: "Needs sign-in", dotClassName: "bg-warning" },
  "not-installed": { label: "Not installed", dotClassName: "bg-muted-foreground/40" },
  detecting: { label: "Detecting", dotClassName: "bg-muted-foreground/40" },
  "check-failed": { label: "Could not check", dotClassName: "bg-warning" },
  disabled: { label: "Disabled", dotClassName: "bg-muted-foreground/40" },
};

const INLINE_ACTION_CLASS_NAME =
  "cursor-pointer text-foreground underline decoration-foreground/40 underline-offset-[3px] transition-colors hover:decoration-foreground motion-reduce:transition-none";

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
        const normalized = normalizeProviderStatusForLocalConfig({
          provider: status.provider,
          status,
          customBinaryPath: getCustomBinaryPathForProvider(settings, status.provider),
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

  const rows = PROVIDER_DESCRIPTORS.map((descriptor) => {
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
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2.5">
        {rows.map(({ descriptor, state }) => {
          const presentation = STATE_PRESENTATION[state];
          const enabled = state !== "disabled";
          const canConnectInline =
            state === "needs-sign-in" &&
            descriptor.usage?.signInCommand !== undefined &&
            homeDir !== null;
          const isConnecting = connectingProvider === descriptor.kind;
          const checkboxId = `onboarding-provider-${descriptor.kind}`;
          return (
            <div
              key={descriptor.kind}
              className={cn(
                "flex h-[60px] items-center gap-3 px-3.5 transition-opacity motion-reduce:transition-none",
                ONBOARDING_TILE_CLASS_NAME,
                !enabled && "opacity-50",
              )}
            >
              <ProviderIcon provider={descriptor.kind} className="size-5 shrink-0" />
              <label
                htmlFor={checkboxId}
                className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5"
              >
                <span className="truncate text-ui-lg font-medium text-foreground">
                  {descriptor.displayName}
                </span>
                <span className="flex h-lh items-center gap-1.5 text-ui-sm text-muted-foreground">
                  {state === "detecting" ? (
                    <>
                      <Skeleton aria-hidden className="h-2.5 w-20 rounded-full" />
                      <span className="sr-only">{presentation.label}</span>
                    </>
                  ) : (
                    <>
                      <span
                        aria-hidden
                        className={cn("size-1.5 shrink-0 rounded-full", presentation.dotClassName)}
                      />
                      {presentation.label}
                    </>
                  )}
                  {canConnectInline ? (
                    <button
                      type="button"
                      className={cn("ml-1", INLINE_ACTION_CLASS_NAME)}
                      onClick={(event) => {
                        event.preventDefault();
                        toggleConnect(descriptor.kind);
                      }}
                    >
                      {isConnecting ? "Done" : "Sign in"}
                    </button>
                  ) : null}
                  {state === "not-installed" ? (
                    <a
                      href={descriptor.setupDocsHref}
                      target="_blank"
                      rel="noreferrer"
                      className={cn("ml-1", INLINE_ACTION_CLASS_NAME)}
                      onClick={(event) => event.stopPropagation()}
                    >
                      Guide
                    </a>
                  ) : null}
                </span>
              </label>
              <Checkbox
                id={checkboxId}
                checked={enabled}
                aria-label={`${enabled ? "Disable" : "Enable"} ${descriptor.displayName}`}
                onCheckedChange={(checked) =>
                  setProviderDisabled(descriptor.kind, checked !== true)
                }
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 text-ui text-muted-foreground">
        <span aria-live="polite">
          {summary.detecting > 0 ? (
            "Detecting agents on this machine…"
          ) : summary.checkFailed > 0 ? (
            "Couldn't check all agents. Try Re-detect."
          ) : (
            <>
              {summary.connected} connected · {summary.needsSignIn} need sign-in ·{" "}
              {summary.notInstalled} not installed
            </>
          )}
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
          Re-detect
        </button>
      </div>

      <DisclosureRegion open={connecting !== undefined}>
        {connecting && connectingSignInCommand !== undefined && homeDir !== null ? (
          <div ref={terminalRegionRef} className="flex flex-col gap-1.5">
            {/* Always-available close: the card's "Done" link disappears once the
                provider is detected as connected, but the terminal stays mounted. */}
            <div className="flex items-center justify-between text-ui text-muted-foreground">
              <span>
                Signing in to {connecting.descriptor.displayName} ·{" "}
                <code className="text-foreground/80">{connectingSignInCommand}</code>
              </span>
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1 text-foreground/70 transition-colors hover:text-foreground motion-reduce:transition-none"
                onClick={finishConnect}
              >
                <XIcon className="size-3.5" aria-hidden />
                Done
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
