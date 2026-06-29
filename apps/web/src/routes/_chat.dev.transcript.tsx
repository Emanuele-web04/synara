// FILE: _chat.dev.transcript.tsx
// Purpose: Registers the dev transcript state playground under the chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";
import { type ReactElement } from "react";

import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { SidebarInset } from "~/components/ui/sidebar";
import { TranscriptStatePlayground } from "~/components/chat/TranscriptStatePlayground";

export const Route = createFileRoute("/_chat/dev/transcript")({
  component: DevTranscriptRouteView,
});

function DevTranscriptRouteView(): ReactElement {
  if (import.meta.env.DEV) {
    return <TranscriptStatePlayground />;
  }

  return (
    <SidebarInset className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="drag-region flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-3">
        <SidebarHeaderNavigationControls />
        <h1 className="text-sm font-medium">Transcript State Lab</h1>
      </header>
      <main className="flex flex-1 items-center justify-center p-6">
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          This playground is only available in development builds.
        </p>
      </main>
    </SidebarInset>
  );
}
