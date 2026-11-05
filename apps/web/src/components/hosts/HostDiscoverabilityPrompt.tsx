// FILE: HostDiscoverabilityPrompt.tsx
// Purpose: The one-time consent step before a newly registered machine becomes
//          visible and usable to a multi-member workspace (ADR 0002/0015).
// Layer: Web remote-access feature (global dialog).
// Exports: HostDiscoverabilityPrompt

import { useTranslation } from "~/i18n";
import { useCallback, useState } from "react";

import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useAccount } from "~/hooks/useAccount";
import { useHosts } from "~/hooks/useHosts";
import { accountErrorMessage } from "~/lib/accountLogic";
import { shouldPromptForDiscoverability } from "~/lib/hosts/enrollment";

/**
 * Asks once, on first sign-in into a shared workspace, whether this machine
 * should be shared with it.
 *
 * The prompt exists because Desktop registers its bundled host automatically
 * (ADR 0015) and discoverability defaults on (ADR 0002) — frictionless for a
 * solo user, but in a team that default would silently hand every member the
 * ability to run code on someone's laptop. So: personal orgs never see this,
 * and a team sees it exactly once.
 *
 * Both buttons are answers. Declining is a real choice that writes
 * `discoverable: false`, not a dismissal — there is no "ask me later", because
 * a modal that returns every launch is one people learn to click through.
 */
export function HostDiscoverabilityPrompt() {
  const { t } = useTranslation();
  const account = useAccount();
  const remote = useHosts({ enabled: account.me !== null });
  const [dismissed, setDismissed] = useState(false);

  const decision = shouldPromptForDiscoverability(remote.enrollment);
  const host = remote.enrollment?.host ?? null;
  const organizationName =
    account.me?.organization.name ?? t("computer:remote_host_your_workspace");

  const answer = useCallback(
    async (discoverable: boolean) => {
      if (!host) return;
      try {
        await remote.setDiscoverable.mutateAsync({ hostId: host.id, discoverable });
        setDismissed(true);
        toastManager.add({
          type: "success",
          title: discoverable
            ? t("computer:remote_host_machine_shared")
            : t("computer:remote_host_machine_private"),
          description: discoverable
            ? t("computer:remote_host_machine_shared_detail", {
                host: host.name,
                workspace: organizationName,
              })
            : t("computer:remote_host_machine_private_detail", { host: host.name }),
        });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: t("computer:remote_host_save_choice_failed"),
          description: accountErrorMessage(cause, t("chat:tryAgainInAMoment")),
        });
      }
    },
    [host, organizationName, remote.setDiscoverable, t],
  );

  const open = decision.prompt && !dismissed && host !== null;
  if (!host) return null;

  const pending = remote.setDiscoverable.isPending;

  return (
    // No close button: both answers are choices that must be recorded, and an
    // X would leave the host in whatever state it registered with while the
    // owner believes they declined.
    <Dialog open={open}>
      <DialogPopup showCloseButton={false} className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>
            {t("computer:remote_host_share_machine", { workspace: organizationName })}
          </DialogTitle>
          <DialogDescription>
            {t("computer:remote_host_share_machine_description", {
              workspace: organizationName,
              host: host.name,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => void answer(false)}>
            {t("computer:remote_host_keep_private")}
          </Button>
          <Button disabled={pending} onClick={() => void answer(true)}>
            {pending ? t("common:saving2") : t("settings:profile_share")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
