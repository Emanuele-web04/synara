import type { StudioOutputEntry, ThreadId } from "@synara/contracts";
import { isSupportedLocalImagePath } from "@synara/shared/localPreviewFiles";
import { useQuery } from "@tanstack/react-query";

import { formatRelativeTime } from "~/lib/relativeTime";
import { studioThreadOutputsQueryOptions } from "~/lib/serverReactQuery";
import { humanizeStudioOutputName } from "~/lib/studioOutputDisplay";
import { useWorkspaceFileOpener } from "~/lib/workspaceFileOpener";
import { readNativeApi } from "~/nativeApi";

import { FileEntryIcon } from "../FileEntryIcon";
import { EnvironmentLabeledSection, EnvironmentRow } from "./EnvironmentRow";

function revealEntryInFinder(entry: StudioOutputEntry) {
  const api = readNativeApi();
  void api?.shell.showInFolder(entry.fullPath).catch(() => {});
}

export function EnvironmentStudioOutputsSection({
  threadId,
  enabled,
}: {
  threadId: ThreadId;
  enabled: boolean;
}) {
  const outputsQuery = useQuery(studioThreadOutputsQueryOptions({ threadId, enabled }));
  const fileOpener = useWorkspaceFileOpener();

  // click opens in the in-app side panel; meta/ctrl-click — or an unviewable file — reveals it in Finder
  const openEntry = (entry: StudioOutputEntry, forceFinderReveal: boolean) => {
    if (forceFinderReveal || !fileOpener?.openFile(entry.fullPath)) {
      revealEntryInFinder(entry);
    }
  };

  const entries = outputsQuery.data?.entries ?? [];
  if (entries.length === 0) {
    return null;
  }

  return (
    <EnvironmentLabeledSection label="Output">
      {entries.map((entry) => (
        <EnvironmentRow
          key={entry.fullPath}
          // attachment-style glyphs (mimeType null): typed icons like the red PDF, neutral document fallback; images skip the extension color to sit flush with other rows
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
          // the containing folder is plumbing, not user-facing — the label tooltip keeps the full relative path
          trailing={
            <span className="text-ui-xs tabular-nums text-muted-foreground/50">
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
