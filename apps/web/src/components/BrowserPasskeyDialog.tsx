import { useEffect, useState } from "react";
import type { BrowserPasskeyPrompt } from "@synara/contracts";
import { readNativeApi } from "~/nativeApi";
import { observeNativeSurfaceOverlay } from "~/lib/nativeSurfaceOcclusion";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";

export function BrowserPasskeyDialog() {
  const api = readNativeApi()?.browser.passkeys;
  const [prompt, setPrompt] = useState<BrowserPasskeyPrompt | null>(null);
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    let revision = 0;
    const reload = async () => {
      const current = ++revision;
      try {
        const next = await api.snapshot();
        if (mounted && current === revision) setPrompt(next);
      } catch {
        if (mounted && current === revision) setPrompt(null);
      }
    };
    const unsubscribe = api.onChanged(() => {
      void reload();
    });
    void reload();
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [api]);
  if (!api || !prompt) return null;
  const cancel = () => {
    void api.cancel(prompt.id).catch(() => undefined);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogPopup ref={observeNativeSurfaceOverlay} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in with your phone</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4 text-ui">
          <p className="break-all font-medium">{prompt.origin}</p>
          {prompt.rpId !== new URL(prompt.origin).hostname ? (
            <p className="text-ui-sm text-muted-foreground">Passkey for {prompt.rpId}</p>
          ) : null}
          {prompt.phase === "confirm" ? (
            <p>
              Use a passkey saved on your phone to sign in. Keep Bluetooth on and your phone nearby.
            </p>
          ) : null}
          {prompt.phase === "qr" && prompt.svg ? (
            <>
              <img
                className="mx-auto size-70 max-w-full rounded-lg bg-white p-3"
                src={`data:image/svg+xml;base64,${btoa(prompt.svg)}`}
                alt="Scan this QR code with your phone to sign in"
              />
              <p className="text-ui-sm text-muted-foreground">
                Scan with your phone’s camera, then approve the sign-in on your phone.
              </p>
            </>
          ) : null}
          {prompt.phase === "waiting" ? (
            <p role="status">
              Connecting to your phone. Complete any Bluetooth permission or sign-in prompt.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={cancel}>
            Cancel
          </Button>
          {prompt.phase === "confirm" ? (
            <Button
              onClick={() => {
                void api.start(prompt.id).catch(cancel);
              }}
            >
              Continue
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
