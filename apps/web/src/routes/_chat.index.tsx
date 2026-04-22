// FILE: _chat.index.tsx
// Purpose: Open or resume the home-chat draft using the same bootstrap path as standard threads.
// Layer: Routing
// Depends on: shared new-chat handler so "/" stays a thin alias instead of a special chat surface.

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { SplashScreen } from "../components/SplashScreen";
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
    <SplashScreen
      errorMessage={errorMessage}
      onRetry={errorMessage ? () => setAttempt((value) => value + 1) : null}
    />
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
