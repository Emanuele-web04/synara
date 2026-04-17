// FILE: _chat.index.tsx
// Purpose: Open or resume the home-chat draft using the same bootstrap path as standard threads.
// Layer: Routing
// Depends on: shared new-chat handler so "/" stays a thin alias instead of a special chat surface.

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useHandleNewChat } from "../hooks/useHandleNewChat";

function ChatIndexRouteView() {
  const { handleNewChat } = useHandleNewChat();
  const [attempt, setAttempt] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErrorMessage(null);

    void (async () => {
      const result = await handleNewChat({ fresh: true });
      if (cancelled || result.ok) {
        return;
      }
      setErrorMessage(result.error);
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt, handleNewChat]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <span className="text-sm text-muted-foreground/70">
          {errorMessage ? errorMessage : "Preparing new chat…"}
        </span>
        {errorMessage ? (
          <button
            type="button"
            className="rounded-md border border-border/70 px-3 py-1.5 text-sm text-foreground/85 transition-colors hover:bg-accent"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
