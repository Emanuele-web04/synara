// FILE: ProvidersStep.tsx
// Purpose: Agents step of the onboarding: a grid with one cell per runtime, its detection
//          status, an enable/disable switch for the installed ones (bound to the
//          server-backed `disabledProviders` setting), guided sign-in for detected but
//          unauthenticated CLIs, and a setup-guide link for missing ones.
// Layer: Web UI component

import type { ProviderKind } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { ProviderGuidedSignIn } from "~/components/settings/accounts/ProviderGuidedSignIn";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { StatusDot } from "~/components/ui/status-chip";
import { Switch } from "~/components/ui/switch";
import { ChevronRightIcon, RefreshCwIcon } from "~/lib/icons";
import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";
import type { ProviderSetupState } from "../logic";
import type { ProviderDetection } from "../useProviderDetection";
import type { ProviderSetup } from "../useProviderSetup";
import { ONBOARDING_LIVE_COLOR } from "../stage/stageTokens";

/** Status as a dot + word; the dot carries the colour, the copy stays muted. */
const STATE_PRESENTATION: Record<ProviderSetupState, { label: string; dotClassName: string }> = {
  connected: { label: "chat:connected", dotClassName: "bg-[#317CFF]" },
  "needs-sign-in": { label: "common:needsSignIn", dotClassName: "bg-warning" },
  "not-installed": { label: "onboarding:notInstalled", dotClassName: "bg-muted-foreground/40" },
  unavailable: { label: "common:triageOutcome_needsAttention", dotClassName: "bg-warning" },
  detecting: { label: "onboarding:detecting", dotClassName: "bg-muted-foreground/40" },
  "check-failed": { label: "onboarding:couldNotCheck", dotClassName: "bg-warning" },
  disabled: { label: "chat:disabled", dotClassName: "bg-muted-foreground/40" },
};

const CELL_ACTION_CLASS_NAME =
  "inline-flex cursor-pointer items-center gap-0.5 text-ui-sm transition-opacity hover:opacity-75 motion-reduce:transition-none";

export function ProvidersStep(props: {
  readonly detection: ProviderDetection;
  readonly setup: ProviderSetup;
}) {
  const { t } = useTranslation();
  const { detection } = props;
  const { rows, summary, setProviderDisabled } = props.setup;

  // Probe once on entry so a CLI installed while the intro was open shows up.
  const refreshedOnEntryRef = useRef(false);
  useEffect(() => {
    if (refreshedOnEntryRef.current) return;
    refreshedOnEntryRef.current = true;
    void detection.detect({ silent: true });
  }, [detection]);

  // The same isolated sign-in Settings uses: it runs the CLI's login command itself, so
  // nobody has to know that command or open a terminal. Re-probe when it closes.
  const [signingInProvider, setSigningInProvider] = useState<ProviderKind | null>(null);
  const signingIn = signingInProvider
    ? rows.find((row) => row.descriptor.kind === signingInProvider)
    : undefined;

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-foreground/8 bg-background px-8 text-ui text-muted-foreground">
        <span aria-live="polite">
          {summary.detecting > 0
            ? t("onboarding:detectingAgentsOnThisMachine")
            : summary.checkFailed > 0
              ? t("onboarding:couldnTCheckAllAgentsTryReDetect")
              : [
                  t("onboarding:providerSummary", {
                    connected: summary.connected,
                    needsSignIn: summary.needsSignIn,
                    notInstalled: summary.notInstalled,
                  }),
                  // Rare enough to stay out of the line until there is one to report.
                  ...(summary.unavailable > 0
                    ? [t("onboarding:providerSummaryUnavailable", { count: summary.unavailable })]
                    : []),
                ].join(" · ")}
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

      <div className="grid auto-rows-[176px] grid-cols-2 sm:grid-cols-3 xl:grid-cols-5">
        {rows.map(({ descriptor, status, state }) => {
          const presentation = STATE_PRESENTATION[state];
          const enabled = state !== "disabled";
          const installed = status?.available === true;
          // A switch only means something for a CLI that is on this machine: missing
          // agents read as off, and cannot be switched on until they are installed.
          const switchable =
            installed ||
            state === "disabled" ||
            state === "check-failed" ||
            state === "unavailable";
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
                  checked={enabled && switchable}
                  disabled={!switchable}
                  aria-label={t(
                    enabled && switchable ? "settings:disableProvider" : "settings:enableProvider",
                    {
                      provider: descriptor.displayName,
                    },
                  )}
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
                {state === "unavailable" ? (
                  // Installed but unusable: say what the server found, not "set it up".
                  <span
                    className="line-clamp-2 min-h-7 text-ui-xs text-muted-foreground sm:min-h-6"
                    title={status?.message}
                  >
                    {status?.message ?? t("onboarding:providerUnavailableHint")}
                  </span>
                ) : null}
                <span
                  className={cn(
                    "flex h-7 items-center sm:h-6",
                    state === "unavailable" && "hidden",
                  )}
                >
                  {state === "needs-sign-in" ? (
                    <Button
                      size="xs"
                      shape="capsule"
                      className="px-2.5"
                      disabled={signingInProvider !== null}
                      onClick={() => setSigningInProvider(descriptor.kind)}
                    >
                      {t("chat:providerModelPicker_signIn")}
                    </Button>
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

      {signingIn ? (
        <ProviderGuidedSignIn
          key={signingIn.descriptor.kind}
          account={{
            provider: signingIn.descriptor.kind,
            instanceId: signingIn.descriptor.kind,
            label: signingIn.descriptor.displayName,
          }}
          onClosed={() => {
            setSigningInProvider(null);
            void detection.detect({ silent: true });
          }}
        />
      ) : null}
    </div>
  );
}
