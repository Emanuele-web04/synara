// FILE: DelayedLoaderFade.tsx
// Purpose: Fade a loading indicator in after a short delay, so a wait that resolves within
//          a few frames shows only the calm background instead of flashing a spinner.
// Layer: Chat surface UI
// Exports: DelayedLoaderFade

import type { ReactNode } from "react";

export function DelayedLoaderFade(props: { children: ReactNode }) {
  return (
    <>
      {/* Inline @keyframes so the delayed fade needs no global stylesheet. */}
      <style>{`@keyframes delayed-loader-fade-in { from { opacity: 0; } to { opacity: 1; } }`}</style>
      <div className="opacity-0 [animation:delayed-loader-fade-in_200ms_ease-out_150ms_forwards] motion-reduce:animate-none motion-reduce:opacity-100">
        {props.children}
      </div>
    </>
  );
}
