// FILE: ShortcutsDialog.tsx
// Purpose: Render a context-aware keyboard shortcuts reference as a slim, app-style dialog with search.
// Layer: Chat shell overlay
// Depends on: shared dialog UI, shortcut label builder, and current project script metadata.

import type { ResolvedKeybindingsConfig } from "@synara/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { ShortcutKbd } from "./ui/shortcut-kbd";
import {
  buildShortcutSheetSections,
  filterShortcutSheetSections,
  type ShortcutSheetContext,
  type ShortcutSheetSection,
} from "../shortcutsSheet";
import type { ProjectScript } from "../types";

export default function ShortcutsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keybindings: ResolvedKeybindingsConfig;
  projectScripts: ReadonlyArray<ProjectScript>;
  platform: string;
  context: ShortcutSheetContext;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the query each time the dialog opens so the user always starts fresh,
  // and autofocus the search input so they can type immediately after Mod+/.
  useEffect(() => {
    if (!props.open) {
      setQuery("");
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [props.open]);

  const sections = useMemo(
    () =>
      buildShortcutSheetSections({
        keybindings: props.keybindings,
        projectScripts: props.projectScripts,
        platform: props.platform,
        context: props.context,
      }),
    [props.keybindings, props.projectScripts, props.platform, props.context],
  );

  const filteredSections = useMemo(
    () => filterShortcutSheetSections(sections, query),
    [sections, query],
  );

  const hasResults = filteredSections.some((section) => section.entries.length > 0);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader className="pb-2">
          <DialogTitle className="text-base">Keyboard shortcuts</DialogTitle>
          <DialogDescription className="text-xs">
            Reflects the bindings active in your current context.
          </DialogDescription>
          <div className="pt-2">
            <Input
              ref={inputRef}
              type="search"
              size="sm"
              placeholder="Search shortcuts..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query.length > 0) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                }
              }}
              className="rounded-md"
              nativeInput
              aria-label="Search shortcuts"
            />
          </div>
        </DialogHeader>

        <DialogPanel className="max-h-[min(70vh,560px)] px-0 py-0">
          {hasResults ? (
            <div className="flex flex-col">
              {filteredSections.map((section, index) => (
                <ShortcutSection key={section.id} section={section} isFirst={index === 0} />
              ))}
            </div>
          ) : (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              No shortcuts match &ldquo;{query}&rdquo;.
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function ShortcutSection({
  section,
  isFirst,
}: {
  section: ShortcutSheetSection;
  isFirst: boolean;
}) {
  if (section.entries.length === 0) return null;
  const muted = section.tone === "muted";
  return (
    <section className={cn(!isFirst && "border-t border-border/50")}>
      <header className="flex items-baseline justify-between gap-3 px-6 pt-4 pb-2">
        <h3
          className={cn(
            "text-[11px] font-semibold",
            muted ? "text-muted-foreground/70" : "text-muted-foreground",
          )}
        >
          {section.title}
        </h3>
        <p className="truncate text-[11px] text-muted-foreground/70">{section.description}</p>
      </header>
      <ul className={cn("px-3 pb-3", muted && "opacity-75")}>
        {section.entries.map((entry) => (
          <li
            key={entry.id}
            className="group flex items-center justify-between gap-4 rounded-md px-3 py-1.5 hover:bg-muted/60"
          >
            <span className="min-w-0 truncate text-sm text-foreground">{entry.label}</span>
            <ShortcutKbd shortcutLabel={entry.shortcutLabel} groupClassName="shrink-0" />
          </li>
        ))}
      </ul>
    </section>
  );
}
