// FILE: confirmDialogFallback.ts
// Purpose: Renders the lightweight DOM-based confirm dialog used when confirmations come from the web/native bridge.
// Layer: UI fallback helper
// Depends on: global document/body and shared Tailwind theme tokens already loaded by the app.

export function showConfirmDialogFallback(message: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Split message into title (first line) and description (rest)
    const lines = message.split("\n");
    const title = lines[0] ?? message;
    const description = lines.slice(1).join("\n").trim();

    // Backdrop
    const backdrop = document.createElement("div");
    backdrop.className = "fixed inset-0 z-50 bg-black/50";
    backdrop.style.cssText = "animation:fadeIn .15s ease-out";

    // Viewport (centers the dialog)
    const viewport = document.createElement("div");
    viewport.className = "fixed inset-0 z-50 flex items-center justify-center p-4";

    // Popup
    const popup = document.createElement("div");
    popup.className =
      "flex w-full max-w-[22rem] flex-col rounded-xl border border-border/55 bg-popover text-popover-foreground shadow-xl shadow-black/8";
    popup.style.cssText = "animation:scaleIn .15s ease-out";

    // Header
    const header = document.createElement("div");
    header.className = "flex flex-col gap-1.5 px-4 py-3.5 text-center sm:text-left";

    const titleEl = document.createElement("h2");
    titleEl.className = "font-heading font-semibold text-base leading-snug tracking-tight";
    titleEl.textContent = title;
    header.appendChild(titleEl);

    if (description) {
      const descEl = document.createElement("p");
      descEl.className = "text-muted-foreground text-[13px] leading-5";
      descEl.textContent = description;
      header.appendChild(descEl);
    }

    popup.appendChild(header);

    // Footer
    const footer = document.createElement("div");
    footer.className =
      "flex flex-col-reverse gap-2 border-t border-border/45 bg-muted/48 px-4 py-3 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-xl)-1px)]";

    function cleanup(result: boolean) {
      document.removeEventListener("keydown", onKeyDown);
      backdrop.remove();
      viewport.remove();
      resolve(result);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        cleanup(true);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    backdrop.addEventListener("mousedown", () => cleanup(false));

    // Cancel button (outline style)
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.className =
      "inline-flex h-8 min-w-20 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-input bg-popover px-3 text-[13px] font-medium text-foreground outline-none transition-colors hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring/60";
    cancelBtn.addEventListener("click", () => cleanup(false));

    // Confirm button mirrors the chat send action's foreground-on-background treatment.
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.textContent = "Confirm";
    confirmBtn.className =
      "inline-flex h-8 min-w-20 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-foreground bg-foreground px-3 text-[13px] font-medium text-background outline-none transition-all duration-150 hover:scale-[1.02] hover:bg-foreground/92 focus-visible:ring-1 focus-visible:ring-ring/60";

    confirmBtn.addEventListener("click", () => cleanup(true));

    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    popup.appendChild(footer);
    viewport.appendChild(popup);

    document.body.appendChild(backdrop);
    document.body.appendChild(viewport);

    // Auto-focus confirm button
    requestAnimationFrame(() => confirmBtn.focus());
  });
}
