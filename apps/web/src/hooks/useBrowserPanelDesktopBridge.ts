import { useEffect, useEffectEvent } from "react";

export function useBrowserPanelDesktopBridge(input: {
  onToggle: (() => void) | null;
  onOpen: (() => void) | null;
}) {
  const { onOpen, onToggle } = input;
  const handleToggle = useEffectEvent(() => onToggle?.());
  const handleOpen = useEffectEvent(() => onOpen?.());
  const toggleEnabled = onToggle !== null;
  const openEnabled = onOpen !== null;

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function" || !toggleEnabled) {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "toggle-browser") {
        handleToggle();
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [toggleEnabled]);

  useEffect(() => {
    const onOpenBrowserPanelRequest = window.desktopBridge?.browser.onBrowserUseOpenPanelRequest;
    if (typeof onOpenBrowserPanelRequest !== "function" || !openEnabled) {
      return;
    }

    const unsubscribe = onOpenBrowserPanelRequest(() => {
      handleOpen();
    });

    return () => {
      unsubscribe?.();
    };
  }, [openEnabled]);
}
