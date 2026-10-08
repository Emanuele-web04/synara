// FILE: ModelCatalogRefresh.tsx
// Purpose: Check the visible account's catalog, showing progress only while it has
//          no models or the user retries, and offer a retry after failure.
// Layer: Chat picker UI

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { ProviderInstanceId, ProviderKind } from "@synara/contracts";
import type { ProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { RefreshCwIcon } from "~/lib/icons";
import { Button } from "../ui/button";

export function ModelCatalogRefresh(props: {
  provider: ProviderKind;
  instanceId: ProviderInstanceId;
  /** Whether the account already lists models; the open check then stays silent. */
  hasModels: boolean;
  onRefresh: ProviderModelCatalog["refreshModels"];
  onPendingChange?: (instanceId: ProviderInstanceId, pending: boolean) => void;
}) {
  const { provider, instanceId, hasModels, onRefresh, onPendingChange } = props;
  const [pendingMode, setPendingMode] = useState<"if-stale" | "now" | null>(null);
  const [failed, setFailed] = useState(false);
  const requestId = useRef(0);
  const inFlight = useRef(false);
  const refresh = useCallback(
    async (mode: "if-stale" | "now") => {
      if (inFlight.current) return;
      inFlight.current = true;
      const currentRequest = ++requestId.current;
      setPendingMode(mode);
      try {
        await onRefresh(provider, instanceId, mode);
        if (requestId.current === currentRequest) setFailed(false);
      } catch {
        if (requestId.current === currentRequest) setFailed(true);
      } finally {
        if (requestId.current === currentRequest) {
          inFlight.current = false;
          setPendingMode(null);
        }
      }
    },
    [provider, instanceId, onRefresh],
  );

  const checkOnMount = useEffectEvent(() => void refresh("if-stale"));
  useEffect(() => {
    checkOnMount();
    return () => {
      requestId.current += 1;
      inFlight.current = false;
    };
  }, [provider, instanceId]);

  // A cached catalog was warmed when the chat mounted; revalidating it on open
  // updates the rows in place, so only an empty account or a retry shows progress.
  const pending = pendingMode === "now" || (pendingMode === "if-stale" && !hasModels);
  useEffect(() => {
    onPendingChange?.(instanceId, pending);
    return () => onPendingChange?.(instanceId, false);
  }, [instanceId, pending, onPendingChange]);

  if (!pending && !failed) return null;

  return (
    <div className="flex items-center justify-end gap-2 border-t border-border px-2 py-1">
      <span
        role="status"
        className="mr-auto flex items-center gap-2 text-ui-xs text-muted-foreground"
      >
        {pending ? (
          <RefreshCwIcon aria-hidden="true" className="size-3 motion-safe:animate-spin" />
        ) : null}
        {pending ? "Loading models…" : "Couldn’t update models."}
      </span>
      {failed ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={pendingMode !== null}
          onClick={() => void refresh("now")}
        >
          <RefreshCwIcon aria-hidden="true" className="size-3" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}
