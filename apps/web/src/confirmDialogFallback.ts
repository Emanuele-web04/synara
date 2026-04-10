/**
 * Imperative DOM-based confirm dialog that matches the app's AlertDialog styling.
 * Returns a promise that resolves with true (confirmed) or false (cancelled).
 */
export function showConfirmDialogFallback(message: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Split message into title (first line) and description (rest)
    const lines = message.split("\n");
    const title = lines[0] ?? message;
    const description = lines.slice(1).join("\n").trim();

    // Backdrop
    const backdrop = document.createElement("div");
    backdrop.className = "fixed inset-0 z-50 bg-black/60";
    backdrop.style.cssText = "animation:fadeIn .15s ease-out";

    // Viewport (centers the dialog)
    const viewport = document.createElement("div");
    viewport.className = "fixed inset-0 z-50 flex items-center justify-center p-4";

    // Popup
    const popup = document.createElement("div");
    popup.className =
      "flex w-full max-w-sm flex-col rounded-2xl border border-border/60 bg-popover text-popover-foreground shadow-lg/5";
    popup.style.cssText = "animation:scaleIn .15s ease-out";

    // Header
    const header = document.createElement("div");
    header.className = "flex flex-col gap-2 p-6 text-center sm:text-left";

    const titleEl = document.createElement("h2");
    titleEl.className = "font-heading font-semibold text-lg leading-tight";
    titleEl.textContent = title;
    header.appendChild(titleEl);

    if (description) {
      const descEl = document.createElement("p");
      descEl.className = "text-muted-foreground text-sm";
      descEl.textContent = description;
      header.appendChild(descEl);
    }

    popup.appendChild(header);

    // Footer
    const footer = document.createElement("div");
    footer.className =
      "flex flex-col-reverse gap-2 px-6 py-4 border-t border-border/50 bg-muted/72 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]";

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
      "inline-flex h-9 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-sm font-medium text-foreground outline-none transition-shadow hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring/60 sm:h-8";
    cancelBtn.addEventListener("click", () => cleanup(false));

    // Confirm button (primary style)
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.textContent = "Confirm";
    confirmBtn.className =
      "inline-flex h-9 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-sm font-medium text-primary-foreground shadow-xs shadow-primary/24 outline-none transition-shadow hover:bg-primary/90 focus-visible:ring-1 focus-visible:ring-ring/60 sm:h-8";

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
