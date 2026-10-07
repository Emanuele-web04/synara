"use client";

// Shares the profile's URL: the system share sheet where the browser has one (phones),
// otherwise a copy to the clipboard with a brief check mark.

import { useEffect, useState } from "react";

export function ShareProfileButton({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const share = async () => {
    const url = window.location.href;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title, url });
        return;
      } catch (error) {
        // Dismissing the sheet is not a failure; anything else falls back to copying.
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure context, permissions): nothing more to try.
    }
  };

  return (
    <button
      type="button"
      onClick={share}
      aria-label={copied ? "Link copied" : "Share profile"}
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--tile)] text-muted-foreground transition-colors hover:text-foreground"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="size-4"
      >
        {copied ? (
          <path d="M5 12l5 5l10 -10" />
        ) : (
          <>
            <path d="M8 9h-1a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-8a2 2 0 0 0 -2 -2h-1" />
            <path d="M12 14v-11" />
            <path d="M9 6l3 -3l3 3" />
          </>
        )}
      </svg>
    </button>
  );
}
