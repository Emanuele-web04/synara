export function registerCompanionServiceWorker(): void {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    const value: unknown = event.data;
    if (
      value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "companion-push"
    ) {
      window.dispatchEvent(
        new CustomEvent("synara:companion-push", {
          detail: (value as { payload?: unknown }).payload,
        }),
      );
    }
  });
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/mobile/sw.js", { scope: "/mobile/" }).catch(() => {
      // The app remains usable without installation/push support. Settings explains the state.
    });
  });
}
