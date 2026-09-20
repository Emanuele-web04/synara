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
  selectableProjectImportKeys,
  IMPORT_PROVIDER_LABELS,
  type ProjectImportQueueItem,
} from "./logic";
import { ProjectImportProjectCard } from "./ProjectImportProjectCard";

const ACTION_BUTTON = "h-8 rounded-lg px-3 font-normal text-ui sm:text-ui";

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
  const selectableKeys = (catalog?.projects ?? []).flatMap((project) =>
    selectableProjectImportKeys(project, includeArchived).filter((key) => !completedKeys.has(key)),
  );
  const allSelected = selectableKeys.length > 0 && selectableKeys.every((key) => selected.has(key));
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
      setSelected(
        new Set(
          result.projects.flatMap((project) =>
            selectableProjectImportKeys(project, includeArchived),
          ),
        ),
      );
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
    <div className="flex min-h-0 flex-1 flex-col gap-3 text-ui sm:text-ui">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {IMPORT_PROVIDERS.map((provider) => (
          <label
            key={provider}
            className={cn(
              "flex h-8 cursor-pointer items-center gap-2 rounded-lg border px-2.5 transition-colors motion-reduce:transition-none",
              providers.includes(provider)
                ? "border-foreground/14 bg-foreground/[0.05] text-foreground"
                : "border-foreground/8 text-muted-foreground hover:bg-foreground/[0.03]",
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
            <ProviderIcon provider={provider} className="size-3.5 shrink-0" />
            <span>{IMPORT_PROVIDER_LABELS[provider]}</span>
          </label>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-8 rounded-lg font-normal text-ui sm:text-ui"
          disabled={busy || scanning || providers.length === 0}
          onClick={() => void scan()}
        >
          {scanning ? <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden /> : null}
          {scanning ? "Finding projects…" : catalog ? "Scan again" : "Find projects"}
        </Button>
      </div>
      <p className={cn("leading-relaxed text-muted-foreground", "text-ui-sm")}>
        Projects keep their existing folders, and conversations are copied into Synara. Nothing in
        your current projects changes.
      </p>
      {error ? (
        <p role="alert" className={cn("text-destructive", "text-ui-sm")}>
          {error}
        </p>
      ) : null}
      {catalog?.sources.map((source) =>
        source.error ? (
          <p key={source.provider} role="alert" className={cn("text-destructive", "text-ui-sm")}>
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
              className="h-8 min-w-40 flex-1 rounded-lg text-ui sm:text-ui"
            />
            <label className={cn("flex items-center gap-2 text-muted-foreground", "text-ui-sm")}>
              <Checkbox
                checked={includeArchived}
                disabled={busy || scanning}
                onCheckedChange={setIncludeArchived}
              />
              Include archived
            </label>
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 rounded-lg font-normal text-ui sm:text-ui"
              disabled={busy || scanning || selectableKeys.length === 0}
              onClick={() => select(selectableKeys, !allSelected)}
            >
              {allSelected ? "Remove all" : "Select all"}
            </Button>
          </div>
          <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
            {visibleProjects.length > 0 ? (
              <div
                className="divide-y divide-foreground/8 overflow-hidden rounded-xl border border-foreground/10"
                aria-label="Projects available to import"
              >
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
              </div>
            ) : (
              <p className="py-6 text-center text-muted-foreground">
                {catalog.projects.length
                  ? "No projects match your search."
                  : "No local projects found for these providers."}
              </p>
            )}
          </div>
          <p className={cn("shrink-0 leading-relaxed text-muted-foreground/80", "text-ui-sm")}>
            {queue.length > 0 && !running
              ? `${queue.filter((item) => item.input.threadKey !== null).length} conversations across ${projectCount} project${projectCount === 1 ? "" : "s"} selected. `
              : null}
            History shows text messages; tool details and attachments may be missing.
          </p>
        </>
      ) : null}
      {progress ? (
        <div role="status" aria-live="polite" className="rounded-lg bg-foreground/[0.04] px-3 py-2">
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
              <p className={cn("mt-0.5 truncate text-muted-foreground", "text-ui-sm")}>
                {progress.title}
              </p>
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
        <ul
          aria-label="Import failures"
          className={cn("space-y-1.5 text-destructive", "text-ui-sm")}
        >
          {failures.map(([key, failure]) => (
            <li key={key}>
              <span className="font-medium">{failure.title}</span>: {failure.error}
            </li>
          ))}
        </ul>
      ) : null}
      {catalog ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-foreground/8 pt-2.5">
          {running ? (
            <Button
              variant="outline"
              size="sm"
              className={ACTION_BUTTON}
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
                  className={ACTION_BUTTON}
                  disabled={busy || scanning}
                  onClick={() => void run(retryQueue)}
                >
                  Retry failed ({retryQueue.length})
                </Button>
              ) : null}
              <Button
                size="sm"
                className={ACTION_BUTTON}
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
