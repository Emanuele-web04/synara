// FILE: ProviderHealthBanner.tsx
// Purpose: Surfaces provider availability warnings above the active chat. A signed-out
//          provider gets a Sign in action that runs the CLI's login inside Synara.
// Layer: Chat status presentation
// Exports: ProviderHealthBanner

import { PROVIDER_DISPLAY_NAMES, type ServerProviderStatus } from "@synara/contracts";
import { useState } from "react";
import { providerAccountNeedsSignIn } from "~/lib/providerSetupStatus";
import { ProviderGuidedSignIn } from "../settings/accounts/ProviderGuidedSignIn";
import type { ProviderSignInAccount } from "../settings/accounts/providerAccountShared";
import { Button } from "../ui/button";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { IconButton } from "../ui/icon-button";
import {
  EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME,
  NOTIFICATION_ICON_CLASS_NAME,
} from "../ui/notificationSurface";
import { CircleAlertIcon, TriangleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ChatColumnBannerFrame } from "./ChatColumnBannerFrame";
import { isProviderKind } from "../../providerOrdering";
import { useTranslation } from "~/i18n";

export const ProviderHealthBanner = function ProviderHealthBanner({
  onDismiss,
  status,
}: {
  onDismiss?: () => void;
  status: ServerProviderStatus | null;
}) {
  const { t } = useTranslation();
  const [signInAccount, setSignInAccount] = useState<ProviderSignInAccount | null>(null);
  const signInDialog = signInAccount ? (
    <ProviderGuidedSignIn
      key={String(signInAccount.instanceId)}
      account={signInAccount}
      onClosed={() => setSignInAccount(null)}
    />
  ) : null;

  // The dialog is a stable sibling of the banner: signing in flips the status to ready
  // mid-flow, and the banner leaving must not remount the sign-in session.
  if (!status || status.status === "ready") {
    return <>{signInDialog}</>;
  }

  const providerLabelFallback = isProviderKind(status.provider)
    ? PROVIDER_DISPLAY_NAMES[status.provider]
    : status.provider;
  const providerLabel = status.displayName?.trim() || providerLabelFallback || status.provider;
  const defaultMessage =
    status.status === "error"
      ? t("chat:providerIsUnavailable", { value0: providerLabel })
      : t("chat:providerHasLimitedAvailability", { value0: providerLabel });
  const driver = status.driver ?? status.provider;
  const signInProvider =
    isProviderKind(driver) &&
    providerAccountNeedsSignIn({ status, enabled: status.enabled !== false })
      ? driver
      : null;
  const title = signInProvider
    ? t("settings:signInTo2", { value0: providerLabel })
    : t("chat:providerStatus", { value0: providerLabel });
  const message = signInProvider
    ? t("chat:providerHealthBanner_signInBody", { provider: providerLabel })
    : (status.message ?? defaultMessage);
  const Icon = status.status === "error" ? CircleAlertIcon : TriangleAlertIcon;

  return (
    <>
      {signInDialog}
      <ChatColumnBannerFrame>
        <Alert
          className={cn(EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME, "pr-10")}
          variant={status.status === "error" ? "error" : "warning"}
        >
          <Icon className={NOTIFICATION_ICON_CLASS_NAME} />
          <AlertTitle className="font-normal text-[var(--notification-fg)]">{title}</AlertTitle>
          <AlertDescription
            className="line-clamp-3 text-[var(--notification-fg)]/72"
            title={message}
          >
            {message}
          </AlertDescription>
          {signInProvider ? (
            <div className="col-start-2 pt-1.5">
              <Button
                size="xs"
                disabled={signInAccount !== null}
                onClick={() =>
                  setSignInAccount({
                    provider: signInProvider,
                    instanceId: status.instanceId ?? signInProvider,
                    label: providerLabel,
                  })
                }
              >
                {t("chat:providerModelPicker_signIn")}
              </Button>
            </div>
          ) : null}
          {onDismiss ? (
            <AlertAction className="absolute top-2 right-2">
              <IconButton
                className="size-6 rounded-full text-[var(--notification-fg)]/65 hover:bg-[var(--notification-fg)]/10 hover:text-[var(--notification-fg)] focus-visible:ring-[var(--notification-fg)]/35 sm:size-6"
                label={t("chat:providerHealthBanner_dismissLabel")}
                title={t("chat:providerHealthBanner_dismissLabel")}
                onClick={onDismiss}
              >
                <XIcon className="size-3.5" />
              </IconButton>
            </AlertAction>
          ) : null}
        </Alert>
      </ChatColumnBannerFrame>
    </>
  );
};
