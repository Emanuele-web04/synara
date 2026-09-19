import type {
  ImportProjectResult,
  ListProjectImportsResult,
  ProjectImportProvider,
} from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { CheckIcon, LoaderCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import {
  buildProjectImportQueue,
  IMPORT_PROVIDERS,
  IMPORT_PROVIDER_LABELS,
  type ProjectImportQueueItem,
} from "./logic";
import { ProjectImportProjectCard } from "./ProjectImportProjectCard";

interface ImportOutcome {
  readonly title: string;
  readonly error: string | null;
}

export function ProjectImportPanel(props: {
  readonly onBusyChange: (busy: boolean) => void;
  readonly initialProviders?: readonly ProjectImportProvider[];
  readonly onResult?: (
    result: ImportProjectResult,
    workspaceRoot: string,
    created: boolean,
  ) => void;
}) {
  const [providers, setProviders] = useState<readonly ProjectImportProvider[]>(
    props.initialProviders ?? IMPORT_PROVIDERS,
  );
  const [catalog, setCatalog] = useState<ListProjectImportsResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [workspaceRoots, setWorkspaceRoots] = useState<Record<string, string>>({});
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [outcomes, setOutcomes] = useState<Record<string, ImportOutcome>>({});
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    title: string;
  } | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const stopRef = useRef(false);
  const mountedRef = useRef(true);
  const syncSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const { onBusyChange } = props;
  const busy = running || picking;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRef.current = true;
      onBusyChange(false);
    };
  }, [onBusyChange]);

  const completedKeys = new Set(
    Object.entries(outcomes)
      .filter(([, value]) => value.error === null)
      .map(([key]) => key),
  );
  const queue = buildProjectImportQueue({
    projects: catalog?.projects ?? [],
    selected,
    includeArchived,
    workspaceRoots,
  }).filter((item) => !completedKeys.has(item.key));
  const failures = Object.entries(outcomes).filter(([, value]) => value.error !== null);
  const retryQueue = queue.filter((item) => outcomes[item.key]?.error);
  const projectCount = new Set(queue.map((item) => item.input.projectKey)).size;

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      const result = await ensureNativeApi().orchestration.listProjectImports({ providers });
      if (!mountedRef.current) return;
      setCatalog(result);
      setSelected(new Set());
      setOutcomes({});
      setProgress(null);
    } catch (caught) {
      if (mountedRef.current)
        setError(caught instanceof Error ? caught.message : "Could not find local projects.");
    } finally {
      if (mountedRef.current) setScanning(false);
    }
  };

  const run = async (items: readonly ProjectImportQueueItem[]) => {
    if (items.length === 0 || busy) return;
    stopRef.current = false;
    setStopRequested(false);
    setRunning(true);
    setError(null);
    try {
      const api = ensureNativeApi();
      for (const [index, item] of items.entries()) {
        if (stopRef.current) break;
        setProgress({ current: index + 1, total: items.length, title: item.title });
        try {
          const result = await api.orchestration.importProject(item.input);
          if (!mountedRef.current) break;
          setOutcomes((current) => ({
            ...current,
            [item.key]: { title: item.title, error: null },
          }));
          const project = catalog?.projects.find((entry) => entry.key === item.input.projectKey);
          props.onResult?.(result, item.workspaceRoot, project?.existingProjectId === null);
        } catch (caught) {
          if (!mountedRef.current) break;
          setOutcomes((current) => ({
            ...current,
            [item.key]: {
              title: item.title,
              error: caught instanceof Error ? caught.message : "Import failed. Try again.",
            },
          }));
        }
      }
      // Refresh once per batch. Import events also update the live store while the batch runs.
      try {
        const snapshot = await api.orchestration.getShellSnapshot();
        if (mountedRef.current) syncSnapshot(snapshot);
      } catch {
        // A reconnect will hydrate the store; successful durable imports remain successful.
      }
    } catch (caught) {
      if (mountedRef.current)
        setError(caught instanceof Error ? caught.message : "Could not start the import.");
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  };

  const select = (keys: readonly string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  const query = search.trim().toLowerCase();
  const visibleProjects =
    catalog?.projects.filter((project) =>
      `${project.title} ${project.workspaceRoot}`.toLowerCase().includes(query),
    ) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Projects use their existing folders. Conversations become independent copies in Synara.
        Existing projects keep their settings and conversations.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {IMPORT_PROVIDERS.map((provider) => (
          <label
            key={provider}
            className={cn(
              "flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-3",
              providers.includes(provider)
                ? "border-primary/35 bg-primary/5"
                : "border-foreground/10",
            )}
          >
            <Checkbox
              aria-label={IMPORT_PROVIDER_LABELS[provider]}
              checked={providers.includes(provider)}
              disabled={busy || scanning}
              onCheckedChange={(checked) => {
                setProviders((current) =>
                  checked ? [...current, provider] : current.filter((item) => item !== provider),
                );
                setCatalog(null);
                setOutcomes({});
                setProgress(null);
              }}
            />
            <ProviderIcon provider={provider} className="size-5 shrink-0" />
            <span className="text-sm font-medium">{IMPORT_PROVIDER_LABELS[provider]}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          Reads local conversation archives on this server.
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || scanning || providers.length === 0}
          onClick={() => void scan()}
        >
          {scanning ? <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden /> : null}
          {scanning ? "Finding projects…" : catalog ? "Scan again" : "Find projects"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {catalog?.sources.map((source) =>
        source.error ? (
          <p key={source.provider} role="alert" className="text-xs text-destructive">
            {IMPORT_PROVIDER_LABELS[source.provider]}: {source.error}
          </p>
        ) : null,
      )}
      {catalog ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              aria-label="Search imported projects"
              placeholder="Search projects or folders…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-8 min-w-40 flex-1 text-xs"
            />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={includeArchived}
                disabled={busy || scanning}
                onCheckedChange={setIncludeArchived}
              />
              Include archived
            </label>
          </div>
          <div className="flex flex-col gap-2" aria-label="Projects available to import">
            {visibleProjects.map((project) => (
              <ProjectImportProjectCard
                key={project.key}
                project={project}
                selected={selected}
                includeArchived={includeArchived}
                disabled={busy || scanning}
                completedKeys={completedKeys}
                workspaceRoot={workspaceRoots[project.key] ?? ""}
                onWorkspaceRootChange={(path) =>
                  setWorkspaceRoots((current) => ({ ...current, [project.key]: path }))
                }
                onSelectionChange={select}
                onPickerBusyChange={setPicking}
              />
            ))}
            {visibleProjects.length === 0 ? (
              <p className="rounded-xl border border-dashed border-foreground/12 p-6 text-center text-sm text-muted-foreground">
                {catalog.projects.length
                  ? "No projects match your search."
                  : "No local projects found for these providers."}
              </p>
            ) : null}
          </div>
          {queue.length > 0 && !running ? (
            <p className="text-xs text-muted-foreground">
              {queue.filter((item) => item.input.threadKey !== null).length} conversations across{" "}
              {projectCount} project{projectCount === 1 ? "" : "s"} selected. Archived conversations
              stay archived. Folder contents are never copied.
            </p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            The visible history includes supported text messages. Historical tool details and
            attachments may not be displayed.
          </p>
        </>
      ) : null}
      {progress ? (
        <div role="status" aria-live="polite" className="rounded-xl bg-foreground/3 p-3 text-xs">
          {running ? (
            <>
              <div className="flex items-center gap-2">
                <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
                <span>
                  {stopRequested
                    ? "Stopping after this conversation…"
                    : `Importing ${progress.current} of ${progress.total}`}
                </span>
              </div>
              <p className="mt-1 truncate text-muted-foreground">{progress.title}</p>
            </>
          ) : (
            <p className="flex items-center gap-2">
              <CheckIcon className="size-3.5 text-success" aria-hidden />
              {completedKeys.size} imported or already present
              {stopRequested
                ? ". Import stopped; remaining selections are ready to continue."
                : "."}
            </p>
          )}
        </div>
      ) : null}
      {failures.length > 0 ? (
        <ul aria-label="Import failures" className="space-y-2 text-xs text-destructive">
          {failures.map(([key, failure]) => (
            <li key={key}>
              <span className="font-medium">{failure.title}</span>: {failure.error}
            </li>
          ))}
        </ul>
      ) : null}
      {catalog ? (
        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-foreground/8 bg-popover py-3">
          {running ? (
            <Button
              variant="outline"
              size="sm"
              disabled={stopRequested}
              onClick={() => {
                stopRef.current = true;
                setStopRequested(true);
              }}
            >
              Stop after current
            </Button>
          ) : (
            <>
              {retryQueue.length > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || scanning}
                  onClick={() => void run(retryQueue)}
                >
                  Retry failed ({retryQueue.length})
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={busy || scanning || queue.length === 0}
                onClick={() => void run(queue)}
              >
                {progress ? "Import remaining" : "Import selected"}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
