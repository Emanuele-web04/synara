"use client";

// The profile's Share button and its sheet: pick how to send the profile (the link, a 4:5
// poster, a 9:16 story receipt or the link-preview card), see it, then share it through the
// system share sheet where the browser has one, or copy/download it otherwise. A bottom
// sheet on phones, a centered panel on larger screens.

import { useEffect, useRef, useState } from "react";

type ShareChoice = "link" | "poster" | "story" | "card";

const CHOICES: { id: ShareChoice; label: string; ratio: string }[] = [
  { id: "link", label: "Link", ratio: "" },
  { id: "poster", label: "Poster", ratio: "4 / 5" },
  { id: "story", label: "Story", ratio: "9 / 16" },
  { id: "card", label: "Card", ratio: "1200 / 630" },
];

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function ShareProfileButton({ handle, title }: { handle: string; title: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [choice, setChoice] = useState<ShareChoice>("link");
  const [status, setStatus] = useState<"idle" | "working" | "copied" | "failed">("idle");

  useEffect(() => {
    if (status !== "copied" && status !== "failed") return;
    const timer = setTimeout(() => setStatus("idle"), 1800);
    return () => clearTimeout(timer);
  }, [status]);

  const profileUrl = () => `${window.location.origin}/@${handle}`;
  const imagePath = (format: Exclude<ShareChoice, "link">) => `/@${handle}/share/${format}`;
  const fileName = (format: string) => `synara-${handle}-${format}.png`;

  const imageFile = async (format: Exclude<ShareChoice, "link">) => {
    const response = await fetch(imagePath(format));
    if (!response.ok) throw new Error(`Share image failed with ${response.status}`);
    return new File([await response.blob()], fileName(format), { type: "image/png" });
  };

  // Promise chains, not try/catch: matches the app's React Compiler-friendly handlers.
  const share = () => {
    setStatus("working");
    const url = profileUrl();
    const payload: Promise<ShareData> =
      choice === "link"
        ? Promise.resolve({ title, url })
        : imageFile(choice).then((file) => ({ title, url, files: [file] }));
    return payload
      .then((data) => {
        if (typeof navigator.share === "function" && (!data.files || navigator.canShare?.(data))) {
          return navigator.share(data).then(() => setStatus("idle"));
        }
        // No share sheet (most desktops): copy the link, or save the image.
        return choice === "link" ? copyLink() : download();
      })
      .catch((error: unknown) => {
        // Dismissing the system sheet is not a failure.
        setStatus(error instanceof DOMException && error.name === "AbortError" ? "idle" : "failed");
      });
  };

  const copyLink = () =>
    navigator.clipboard.writeText(profileUrl()).then(
      () => setStatus("copied"),
      () => setStatus("failed"),
    );

  const download = () => {
    if (choice === "link") return copyLink();
    setStatus("working");
    return imageFile(choice)
      .then((file) => {
        const href = URL.createObjectURL(file);
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = file.name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
        setStatus("idle");
      })
      .catch(() => setStatus("failed"));
  };

  const selected = CHOICES.find((entry) => entry.id === choice)!;

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        aria-label="Share profile"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--tile)] text-muted-foreground transition-colors hover:text-foreground"
      >
        <svg {...ICON_PROPS} className="size-4">
          <path d="M8 9h-1a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-8a2 2 0 0 0 -2 -2h-1" />
          <path d="M12 14v-11" />
          <path d="M9 6l3 -3l3 3" />
        </svg>
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="share-profile-title"
        onClick={(event) => {
          // A click on the backdrop (the dialog element itself) closes it.
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
        className="m-0 mt-auto w-full max-w-none bg-transparent p-0 text-foreground backdrop:bg-black/40 backdrop:backdrop-blur-[2px] sm:m-auto sm:max-w-[440px]"
      >
        <div className="flex flex-col gap-5 rounded-t-[28px] bg-background px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-5 shadow-2xl ring-1 ring-[var(--hairline)] sm:rounded-[28px] sm:pb-5">
          <div className="flex items-center justify-between">
            <h2 id="share-profile-title" className="text-[15px] font-semibold">
              Share profile
            </h2>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              aria-label="Close"
              className="flex size-8 items-center justify-center rounded-full bg-[var(--tile)] text-muted-foreground transition-colors hover:text-foreground"
            >
              <svg {...ICON_PROPS} className="size-3.5">
                <path d="M18 6l-12 12" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div role="radiogroup" aria-label="Format" className="grid grid-cols-4 gap-2">
            {CHOICES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={choice === entry.id}
                onClick={() => setChoice(entry.id)}
                className={`flex flex-col items-center gap-2 rounded-2xl px-2 pb-2.5 pt-3 text-xs transition-colors ${
                  choice === entry.id
                    ? "bg-[var(--tile)] text-foreground ring-1 ring-[var(--info)]"
                    : "text-muted-foreground hover:bg-[var(--tile)]"
                }`}
              >
                <span className="flex h-9 items-center justify-center">
                  {entry.id === "link" ? (
                    <svg {...ICON_PROPS} className="size-5">
                      <path d="M9 15l6 -6" />
                      <path d="M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464" />
                      <path d="M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463" />
                    </svg>
                  ) : (
                    <span
                      aria-hidden
                      className="block h-full max-w-9 rounded-[5px] border-[1.5px] border-current"
                      style={{ aspectRatio: entry.ratio }}
                    />
                  )}
                </span>
                {entry.label}
              </button>
            ))}
          </div>

          <div className="flex h-[min(46vh,380px)] items-center justify-center rounded-2xl bg-[var(--tile)] p-4">
            {choice === "link" ? (
              <span className="max-w-full truncate rounded-full bg-background px-4 py-2 text-[13px] text-muted-foreground ring-1 ring-[var(--hairline)]">
                trysynara.com/@{handle}
              </span>
            ) : (
              // The route renders the PNG on request; each format loads only once picked.
              <img
                key={choice}
                src={imagePath(choice)}
                alt={`${selected.label} image of @${handle}`}
                className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void download()}
              disabled={status === "working"}
              className="h-11 rounded-full bg-[var(--tile)] text-[13px] font-medium transition-opacity disabled:opacity-50"
            >
              {choice === "link" ? (status === "copied" ? "Copied" : "Copy link") : "Download"}
            </button>
            <button
              type="button"
              onClick={() => void share()}
              disabled={status === "working"}
              className="h-11 rounded-full bg-foreground text-[13px] font-medium text-background transition-opacity disabled:opacity-50"
            >
              {status === "working" ? "Preparing…" : status === "failed" ? "Try again" : "Share"}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
