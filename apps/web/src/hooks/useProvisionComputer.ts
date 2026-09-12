// FILE: useProvisionComputer.ts
// Purpose: The single "Set up computer control" mutation, shared by the chat's setup
//          card and the Computer settings panel.
// Layer: Web data hook
// Exports: useProvisionComputer
// Depends on: provisionComputer RPC, computerProvisioning copy, toast manager
//
// Provisioning changes the machine — it installs packages, compiles a helper and
// puts an OS permission dialog on screen — so there must be exactly one of it in
// flight and exactly one account of what happened. Both surfaces used to own a
// private implementation: one raised toasts and the other did not, neither had a
// pending state that stopped a second press, and pressing Set up in the panel
// while the card's Set up was still running started a second provision against
// the same helper.

import type { ComputerPermission, ComputerProvisionResult } from "@synara/contracts";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import {
  computerProvisionErrorToast,
  computerProvisionNote,
  computerProvisionOutcome,
  computerProvisionResultToast,
  computerProvisionStartToast,
} from "~/lib/computerProvisioning";
import { provisionComputer, serverQueryKeys } from "~/lib/serverReactQuery";

const COMPUTER_PROVISION_MUTATION_KEY = ["computer", "provision"] as const;

export interface UseProvisionComputerResult {
  /** Starts a provision, or does nothing while one is already running. */
  readonly provision: () => void;
  readonly isPending: boolean;
  /** The settings panel's inline account of the attempt; undefined when there is nothing to say. */
  readonly note: string | undefined;
}

export function useProvisionComputer(options?: {
  /**
   * The grants the OS is currently withholding, so the opening toast can name
   * them. Optional: a surface that does not know yet gets the general wording.
   */
  readonly missing?: readonly ComputerPermission[];
  /**
   * Toasts are how a transcript card reports; the settings panel keeps the same
   * words in an inline row instead and would otherwise say everything twice.
   */
  readonly notify?: boolean;
  /** Ran once, after a provision that left nothing to set up. */
  readonly onReady?: (result: ComputerProvisionResult) => void;
}): UseProvisionComputerResult {
  const notify = options?.notify ?? false;
  const missing = options?.missing;
  const onReady = options?.onReady;
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationKey: COMPUTER_PROVISION_MUTATION_KEY,
    mutationFn: provisionComputer,
    onSuccess: (result) => {
      // Legacy setup returns its final status; the native guide also pushes later grants.
      if (globalThis.window?.desktopBridge?.permissions) {
        // Native setup can advance while the initiating RPC is returning.
        // Do not overwrite a newer grant push with its earlier status snapshot.
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.computerStatus() });
      } else {
        queryClient.setQueryData(serverQueryKeys.computerStatus(), result.status);
      }
      if (
        notify &&
        (!globalThis.window?.desktopBridge?.permissions ||
          computerProvisionOutcome(result) === "ready")
      )
        toastManager.add(computerProvisionResultToast(result));
      if (computerProvisionOutcome(result) === "ready") onReady?.(result);
    },
    onError: (error: unknown) => {
      if (notify) toastManager.add(computerProvisionErrorToast(error));
    },
  });

  const isPending = useIsMutating({ mutationKey: COMPUTER_PROVISION_MUTATION_KEY }) > 0;
  const { mutate } = mutation;
  const provision = () => {
    // React Query happily runs a second mutation over the first; a second
    // provision would re-enter the installer and re-arm the permission prompt
    // behind the dialog the user is already looking at.
    if (queryClient.isMutating({ mutationKey: COMPUTER_PROVISION_MUTATION_KEY }) > 0) return;
    if (notify) toastManager.add(computerProvisionStartToast(missing));
    mutate();
  };

  return {
    provision,
    isPending,
    note: computerProvisionNote({
      isPending,
      ...(missing ? { missing } : {}),
      error: mutation.error,
      result: globalThis.window?.desktopBridge?.permissions ? undefined : mutation.data,
    }),
  };
}
