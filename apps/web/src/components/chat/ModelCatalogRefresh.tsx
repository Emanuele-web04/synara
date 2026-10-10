// FILE: ModelCatalogRefresh.tsx
// Purpose: Silently check the visible catalog; expose a retry only after failure.
// Layer: Chat picker UI

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
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
      try {
        await onRefresh(provider, instanceId, mode);
        if (requestId.current === currentRequest) setFailed(false);
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

  const checkOnMount = useEffectEvent(() => void refresh("if-stale"));
  useEffect(() => {
    checkOnMount();
    return () => {
      requestId.current += 1;
      inFlight.current = false;
    };
  }, [provider, instanceId]);

  if (!failed) return null;

  return (
    <div className="flex items-center justify-end gap-2 border-t border-border px-2 py-1">
      <span role="status" className="mr-auto text-ui-xs text-muted-foreground">
        {pending ? "Checking for models…" : "Couldn’t update models."}
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
        Retry
      </Button>
    </div>
  );
}
