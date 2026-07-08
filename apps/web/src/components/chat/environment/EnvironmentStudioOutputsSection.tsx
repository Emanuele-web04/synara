// FILE: EnvironmentStudioOutputsSection.tsx
// Purpose: Environment panel section listing the files THIS Studio chat produced anywhere
//          under the Studio root (attributed server-side from checkpoints, file-change
//          activities, or per-turn output capture). Click opens the file in the in-app
//          side panel viewer; meta/ctrl-click (or an unviewable file) reveals it in the
//          Finder instead. The section renders nothing until the chat has actually
//          produced output, so non-producing chats keep a clean panel.
// Layer: Environment panel section
// Depends on: studio.listThreadOutputs WS method + shell.showInFolder.

import type { StudioOutputEntry, ThreadId } from "@t3tools/contracts";
import { isSupportedLocalImagePath } from "@t3tools/shared/localPreviewFiles";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import { formatRelativeTime } from "~/lib/relativeTime";
import { studioThreadOutputsQueryOptions } from "~/lib/serverReactQuery";
import { humanizeStudioOutputName } from "~/lib/studioOutputDisplay";
import { useWorkspaceFileOpener } from "~/lib/workspaceFileOpener";
import { readNativeApi } from "~/nativeApi";

import { FileEntryIcon } from "../FileEntryIcon";
import { EnvironmentLabeledSection, EnvironmentRow } from "./EnvironmentRow";

export function EnvironmentStudioOutputsSection({
  threadId,
  enabled,
}: {
  threadId: ThreadId;
  enabled: boolean;
}) {
  const outputsQuery = useQuery(studioThreadOutputsQueryOptions({ threadId, enabled }));
  const fileOpener = useWorkspaceFileOpener();

  const revealEntryInFinder = useCallback((entry: StudioOutputEntry) => {
    const api = readNativeApi();
    void api?.shell.showInFolder(entry.fullPath).catch(() => {});
  }, []);

  // Plain click opens the output in the in-app side panel; meta/ctrl-click — or a
  // file the panel can't view — reveals it in the Finder instead.
  const openEntry = useCallback(
    (entry: StudioOutputEntry, forceFinderReveal: boolean) => {
      if (forceFinderReveal || !fileOpener?.openFile(entry.fullPath)) {
        revealEntryInFinder(entry);
      }
    },
    [fileOpener, revealEntryInFinder],
  );

  const entries = outputsQuery.data?.entries ?? [];
  if (entries.length === 0) {
    return null;
  }

  return (
    <EnvironmentLabeledSection label="Output">
      {entries.map((entry) => (
        <EnvironmentRow
          key={entry.fullPath}
          // Attachment-style resolution (mimeType null): typed glyphs like the red PDF
          // icon, and a neutral document fallback instead of the source-code bracket.
          // Image glyphs skip the extension color (bright green) and use the panel's
          // standard foreground so they sit flush with the other environment rows.
          icon={
            <FileEntryIcon
              pathValue={entry.name}
              kind="file"
              mimeType={null}
              {...(isSupportedLocalImagePath(entry.name)
                ? {
                    colorMode: "inherit" as const,
                    className: "text-[var(--color-text-foreground)]",
                  }
                : {})}
            />
          }
          label={<span title={entry.relativePath}>{humanizeStudioOutputName(entry.name)}</span>}
          // The containing folder is plumbing, not user-facing info: the tooltip on the
          // label keeps the full relative path for whoever needs it.
          trailing={
            <span className="text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground/50">
              {formatRelativeTime(entry.modifiedAt)}
            </span>
          }
          onClick={(event) => openEntry(entry, event.metaKey || event.ctrlKey)}
          onMouseEnter={() => fileOpener?.prefetchFile?.(entry.fullPath)}
        />
      ))}
    </EnvironmentLabeledSection>
  );
}
