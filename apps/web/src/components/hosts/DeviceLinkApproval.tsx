// FILE: DeviceLinkApproval.tsx
// Purpose: The owner's half of the headless device-code flow — enter the code a
//          browserless machine printed, approve the link (ADR 0015 path 3).
// Layer: Route-level screen (mounted at /link).
// Exports: DeviceLinkApproval, DeviceCodeField

import { useTranslation } from "~/i18n";
import { useCallback, useId, useState } from "react";

import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { ShortCodeField } from "~/components/hosts/ShortCodeField";
import { Button } from "~/components/ui/button";
import { SidebarInset } from "~/components/ui/sidebar";
import { useAccount } from "~/hooks/useAccount";
import { accountErrorMessage } from "~/lib/accountLogic";
import { ensureHostsApi } from "~/lib/hosts/api";
import { DEVICE_USER_CODE_LENGTH, isCompleteDeviceUserCode } from "~/lib/hosts/enrollment";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { cn } from "~/lib/utils";
import { SETTINGS_CARD_CLASS_NAME } from "~/settingsPanelStyles";

// An example of the protocol code alphabet, not translatable prose.
const DEVICE_CODE_EXAMPLE = "ABCD-EFGH";

type ApprovalState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "approved" }
  | { readonly status: "failed"; readonly message: string };

/**
 * The code field.
 *
 * Extracted so the normalization is testable without a browser: everything
 * interesting about this input happens between the keystroke and the state
 * write. Displayed as `ABCD-EFGH` in `--font-mono` — a proportional font makes
 * an 8-character code read as a word, and a code is meant to be compared
 * character by character against another screen.
 */
export function DeviceCodeField({
  value,
  disabled,
  onValueChange,
  onSubmit,
  describedBy,
}: {
  /** The normalized code — uppercase, alphabet-only, at most 8 characters. */
  value: string;
  disabled: boolean;
  onValueChange: (normalized: string) => void;
  onSubmit: () => void;
  describedBy?: string;
}) {
  const { t } = useTranslation();
  return (
    <ShortCodeField
      label={t("computer:remote_host_device_code")}
      value={value}
      codeLength={DEVICE_USER_CODE_LENGTH}
      groupSize={4}
      placeholder={DEVICE_CODE_EXAMPLE}
      disabled={disabled}
      {...(describedBy ? { describedBy } : {})}
      onValueChange={onValueChange}
      onSubmit={onSubmit}
    />
  );
}

export function DeviceLinkApproval() {
  const { t } = useTranslation();
  const account = useAccount();
  const [code, setCode] = useState("");
  const [state, setState] = useState<ApprovalState>({ status: "idle" });
  const statusId = useId();
  const trafficLightGutter = useDesktopTopBarTrafficLightGutterClassName();
  const windowControlsGutter = useDesktopTopBarWindowControlsGutterClassName();

  const submit = useCallback(async () => {
    if (!isCompleteDeviceUserCode(code)) return;
    setState({ status: "submitting" });
    try {
      const hosts = ensureHostsApi();
      await hosts.approveDeviceLink({ userCode: code });
      setState({ status: "approved" });
      setCode("");
    } catch (cause) {
      setState({
        status: "failed",
        message: accountErrorMessage(cause, t("computer:remote_host_approve_failed")),
      });
    }
  }, [code, t]);

  const signedIn = account.me !== null;
  const submitting = state.status === "submitting";
  const canSubmit = signedIn && isCompleteDeviceUserCode(code) && !submitting;

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden">
      <div className="flex h-full flex-col">
        <div
          className={cn(
            "drag-region flex shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6",
            trafficLightGutter,
            windowControlsGutter,
          )}
        >
          <SidebarHeaderNavigationControls />
          <span className="text-ui-lg font-medium text-foreground">
            {t("computer:remote_host_link_machine")}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-6">
          <div className="mx-auto w-full max-w-lg space-y-4">
            <div className="space-y-1">
              <h1 className="font-display text-ui-lg text-foreground">
                {t("computer:remote_host_approve_code")}
              </h1>
              <p className="text-ui text-muted-foreground">
                {t("computer:remote_host_device_code_description")}
              </p>
            </div>

            <div className={cn(SETTINGS_CARD_CLASS_NAME, "space-y-4 p-4")}>
              {signedIn ? null : (
                <p className="text-ui text-muted-foreground" role="status">
                  {t("computer:remote_host_sign_in_approve")}
                </p>
              )}
              <DeviceCodeField
                value={code}
                disabled={!signedIn || submitting}
                describedBy={statusId}
                onValueChange={(next) => {
                  setCode(next);
                  // A new code makes the previous verdict meaningless; leaving
                  // a stale error under a fresh code reads as this code failing.
                  if (state.status !== "idle") setState({ status: "idle" });
                }}
                onSubmit={() => void submit()}
              />

              <div className="flex items-center gap-3">
                <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
                  {submitting
                    ? t("computer:remote_host_approving")
                    : t("automation:approval_approve")}
                </Button>
                <span
                  id={statusId}
                  role="status"
                  aria-live="polite"
                  className={cn(
                    "text-ui-sm",
                    state.status === "failed" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {state.status === "approved"
                    ? t("computer:remote_host_approved")
                    : state.status === "failed"
                      ? state.message
                      : isCompleteDeviceUserCode(code)
                        ? t("computer:remote_host_ready_approve")
                        : t("computer:remote_host_enter_characters", {
                            count: DEVICE_USER_CODE_LENGTH,
                          })}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
