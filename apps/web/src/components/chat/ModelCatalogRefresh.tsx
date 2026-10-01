// FILE: ModelCatalogRefresh.tsx
// Purpose: Check one visible model catalog on mount and expose an explicit refresh.
// Layer: Chat picker UI

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderInstanceId, ProviderKind } from "@synara/contracts";
import type { ProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { RefreshCwIcon } from "~/lib/icons";
import { Button } from "../ui/button";

export function ModelCatalogRefresh(props: {
  provider: ProviderKind;
  instanceId: ProviderInstanceId;
  onRefresh: ProviderModelCatalog["refreshModels"];
}) {
  const { provider, instanceId, onRefresh } = props;
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestId = useRef(0);
  const inFlight = useRef(false);
  const refresh = useCallback(
    async (mode: "if-stale" | "now") => {
      if (inFlight.current) return;
      inFlight.current = true;
      const currentRequest = ++requestId.current;
      setPending(true);
      setFailed(false);
      try {
        await onRefresh(provider, instanceId, mode);
      } catch {
        if (requestId.current === currentRequest) setFailed(true);
      } finally {
        if (requestId.current === currentRequest) {
          inFlight.current = false;
          setPending(false);
        }
      }
    },
    [provider, instanceId, onRefresh],
  );

  useEffect(() => {
    void refresh("if-stale");
    return () => {
      requestId.current += 1;
      inFlight.current = false;
    };
  }, [refresh]);

  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-1">
      <span role="status" className="text-ui-xs text-muted-foreground">
        {pending ? "Checking for models…" : failed ? "Couldn’t refresh models. Try again." : null}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={pending}
        onClick={() => void refresh("now")}
      >
        <RefreshCwIcon
          aria-hidden="true"
          className={pending ? "size-3 motion-safe:animate-spin" : "size-3"}
        />
        Refresh models
      </Button>
    </div>
  );
}
