// FILE: StudioOutputsSection.tsx
// Purpose: Sidebar section listing the latest files Studio chats produced in the Outbox,
//          with click-to-reveal in Finder. This is what visually distinguishes Studio from
//          plain chats: the surface shows its artifacts, not just conversations.
// Layer: Web UI (sidebar)
// Depends on: studio.listRecentOutputs WS method + shell.showInFolder.

import type { StudioOutputEntry } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { FiFileText, FiRefreshCw } from "react-icons/fi";

import { formatRelativeTime } from "../lib/relativeTime";
import { readNativeApi } from "../nativeApi";
import { SIDEBAR_SECTION_LABEL_CLASS_NAME } from "../sidebarRowStyles";
import { cn } from "~/lib/utils";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";

const OUTPUTS_LIMIT = 12;
const OUTPUTS_REFRESH_INTERVAL_MS = 30_000;

/** First path segment ("Content", "Daily", ...), or "Outbox" for files at the root. */
function outputSubfolderLabel(entry: StudioOutputEntry): string {
  const separatorIndex = entry.relativePath.indexOf("/");
  return separatorIndex > 0 ? entry.relativePath.slice(0, separatorIndex) : "Outbox";
}

export function StudioOutputsSection() {
  const [entries, setEntries] = useState<readonly StudioOutputEntry[] | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      return;
    }
    let cancelled = false;
    const load = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      api.studio
        .listRecentOutputs({ limit: OUTPUTS_LIMIT })
        .then((result) => {
          if (!cancelled) {
            setEntries(result.entries);
          }
        })
        .catch(() => {
          // Keep whatever we showed last; the next poll retries.
        });
    };
    load();
    const interval = window.setInterval(load, OUTPUTS_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", load);
    };
  }, [refreshToken]);

  const revealEntry = useCallback((entry: StudioOutputEntry) => {
    const api = readNativeApi();
    void api?.shell.showInFolder(entry.fullPath).catch(() => {});
  }, []);

  return (
    <div className="mt-3">
      <div className="group/project-header relative my-1">
        <div
          className={cn(
            "flex h-7 w-full min-w-0 items-center px-2 py-0.5 pr-[4.75rem]",
            SIDEBAR_SECTION_LABEL_CLASS_NAME,
          )}
        >
          <span className="truncate">Output</span>
        </div>
        <SidebarSectionToolbar placement="overlay" revealOnHover>
          <SidebarIconButton
            icon={FiRefreshCw}
            label="Refresh outputs"
            onClick={refresh}
            tooltip="Refresh"
            tooltipSide="bottom"
          />
        </SidebarSectionToolbar>
      </div>

      {entries === null ? null : entries.length === 0 ? (
        <div className="px-2 py-1 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/48">
          No output files yet
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {entries.map((entry) => (
            <button
              key={entry.fullPath}
              type="button"
              className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground/89 transition-colors hover:bg-[var(--sidebar-accent)]"
              title={entry.relativePath}
              onClick={() => revealEntry(entry)}
            >
              <FiFileText className="size-3.5 shrink-0 text-muted-foreground/65" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/50">
                {outputSubfolderLabel(entry)}
              </span>
              <span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground/50">
                {formatRelativeTime(entry.modifiedAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
