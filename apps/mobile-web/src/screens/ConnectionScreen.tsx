import { IconLoader2 } from "@tabler/icons-react";
import type { ConnectionPhase } from "../domain";

export function ConnectionScreen({ phase }: { readonly phase: ConnectionPhase }) {
  return (
    <main className="full-screen-state" aria-busy="true">
      <div className="full-screen-state__brand">
        <img src="/mobile/icons/synara.svg" alt="" width="64" height="64" />
        <span>Synara</span>
      </div>
      <div className="connection-progress" role="status">
        <IconLoader2 className="spin" aria-hidden="true" size={20} />
        <span>{phase === "connecting" ? "Connecting to your host…" : "Checking this device…"}</span>
      </div>
    </main>
  );
}
