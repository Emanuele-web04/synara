// FILE: ProviderSignInDialog.tsx
// Purpose: Human-in-the-loop provider authentication in the shared isolated terminal.
// Layer: Settings UI

import { ThreadId, type ProviderKind } from "@synara/contracts";
import { PROVIDER_AUTHENTICATION } from "@synara/shared/providerCliProfiles";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import TerminalViewport from "../terminal/TerminalViewport";
import type { TerminalRuntimeStatus } from "../terminal/terminalRuntimeTypes";
import { disposeAndCloseTerminalSession } from "../terminal/terminalSession";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";

const ignoreMetadata = () => {};

export default function ProviderSignInDialog(props: {
  provider: ProviderKind;
  instanceId: string;
  accountLabel: string;
  onClose: () => void;
}) {
  const [session] = useState(() => ({
    threadId: ThreadId.makeUnsafe(`provider-auth-${crypto.randomUUID()}`),
    terminalId: "sign-in",
  }));
  const config = useQuery(serverConfigQueryOptions());
  const queryClient = useQueryClient();
  const refresh = useRefreshProviderStatusesNow();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const [runtimeStatus, setRuntimeStatus] = useState<TerminalRuntimeStatus>("connecting");
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [optionsSent, setOptionsSent] = useState(false);
  const alive = useRef(true);
  const checkInFlight = useRef(false);
  const method = PROVIDER_AUTHENTICATION[props.provider];
  const interactiveCommand = "interactiveCommand" in method ? method.interactiveCommand : null;

  const checkStatus = useCallback(async () => {
    if (checkInFlight.current) return;
    checkInFlight.current = true;
    setChecking(true);
    const statuses = await refreshRef.current({ silent: true });
    checkInFlight.current = false;
    if (!alive.current) return;
    setChecking(false);
    const status = statuses?.find(
      (entry) => (entry.instanceId ?? entry.provider) === props.instanceId,
    );
    setResult(
      status?.authStatus === "authenticated"
        ? "Authenticated. You can close this window."
        : status?.authStatus === "unauthenticated"
          ? "This account is not authenticated yet. Complete the sign-in steps and check again."
          : "Authentication could not be verified. Complete the provider's steps and check again; some providers do not expose a login status.",
    );
    // Native account preparation can save its isolated roots server-side.
    void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
  }, [props.instanceId, queryClient]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Strict Mode replays setup/cleanup without closing the window. Allow
      // that synchronous setup to reclaim ownership before disposing the PTY.
      queueMicrotask(() => {
        if (alive.current) return;
        void disposeAndCloseTerminalSession({
          api: readNativeApi(),
          ...session,
          requireStructuredClose: true,
        })
          .catch(() => undefined)
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
            void refreshRef.current({ silent: true });
          });
      });
    };
  }, [session, queryClient]);

  const close = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    try {
      await disposeAndCloseTerminalSession({
        api: readNativeApi(),
        ...session,
        requireStructuredClose: true,
      });
      await queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
      if (alive.current) props.onClose();
    } catch (error) {
      if (alive.current)
        setResult(
          error instanceof Error
            ? error.message
            : "Unable to stop sign-in. Retry closing this window.",
        );
    } finally {
      closingRef.current = false;
      if (alive.current) setClosing(false);
    }
  };

  const showSignInOptions = async () => {
    if (!interactiveCommand || optionsSent) return;
    setOptionsSent(true);
    try {
      await ensureNativeApi().terminal.write({ ...session, data: `${interactiveCommand}\r` });
    } catch (error) {
      if (!alive.current) return;
      setOptionsSent(false);
      setResult(error instanceof Error ? error.message : "Unable to open sign-in options.");
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogPopup className="max-w-3xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Sign in to {props.accountLabel}</DialogTitle>
          <DialogDescription>
            {method.instructions} This runs on the Synara server machine for the selected account.
          </DialogDescription>
        </DialogHeader>
        <div className="h-[min(55vh,28rem)] min-h-48 overflow-hidden rounded-xl border border-border mx-5">
          {config.data?.cwd ? (
            <TerminalViewport
              {...session}
              cwd={config.data.cwd}
              providerAuthInstanceId={props.instanceId}
              terminalLabel={`Sign in · ${props.accountLabel}`}
              onSessionExited={() => void checkStatus()}
              onRuntimeStatusChange={setRuntimeStatus}
              onTerminalMetadataChange={ignoreMetadata}
              onTerminalActivityChange={ignoreMetadata}
              focusRequestId={0}
              autoFocus
              isVisible
            />
          ) : (
            <p className="p-3 text-ui-sm">
              {config.isError ? "Unable to connect to the Synara server." : "Connecting…"}
            </p>
          )}
        </div>
        <p className="mx-5 mt-3 text-ui-sm text-muted-foreground" role="status">
          {result ??
            (runtimeStatus === "error"
              ? "Sign-in could not start. Check the terminal error, close this window and retry."
              : "Follow the provider's prompts. Opening the browser does not confirm authentication.")}
        </p>
        <DialogFooter>
          {interactiveCommand ? (
            <Button
              variant="outline"
              disabled={runtimeStatus !== "ready" || optionsSent || closing}
              onClick={() => void showSignInOptions()}
            >
              Sign-in options
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={closing || checking || runtimeStatus === "connecting"}
            onClick={() => void checkStatus()}
          >
            {checking ? "Checking…" : "Check authentication"}
          </Button>
          <Button disabled={closing} onClick={() => void close()}>
            {closing ? "Closing…" : runtimeStatus === "exited" ? "Close" : "Cancel / close"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
