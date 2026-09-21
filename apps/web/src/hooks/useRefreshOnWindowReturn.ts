import { useEffect, useRef } from "react";

/** Refresh native state after returning from System Settings, without polling or requesting grants. */
export function subscribeToWindowReturn(refresh: () => unknown): () => void {
  let pending = false;
  let disposed = false;
  const onReturn = () => {
    if (disposed || pending || document.visibilityState === "hidden") return;
    pending = true;
    void Promise.resolve()
      .then(() => {
        if (!disposed) return refresh();
      })
      .catch(() => undefined)
      .finally(() => {
        pending = false;
      });
  };
  window.addEventListener("focus", onReturn);
  document.addEventListener("visibilitychange", onReturn);
  return () => {
    disposed = true;
    window.removeEventListener("focus", onReturn);
    document.removeEventListener("visibilitychange", onReturn);
  };
}

export function useRefreshOnWindowReturn(refresh: () => unknown, active = true): void {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (!active) return;
    return subscribeToWindowReturn(() => refreshRef.current());
  }, [active]);
}
