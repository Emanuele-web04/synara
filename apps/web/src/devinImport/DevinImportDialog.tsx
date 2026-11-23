import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import type {
  ExternalHistorySessionDescriptor,
  ExternalHistorySourceDescriptor,
} from "@synara/contracts";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";

import { useDevinImportDialogStore } from "./devinImportDialogStore";

type LoadState = "loading" | "ready" | "error";

const SOURCE_KIND_LABEL_KEYS: Record<string, string> = {
  "devin-local": "workspace:devinImport_sourceDevinLocal",
  "devin-cloud": "workspace:devinImport_sourceDevinCloud",
  "devin-atif": "workspace:devinImport_sourceDevinAtif",
};

function formatUpdatedAt(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function DevinImportDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const open = useDevinImportDialogStore((store) => store.isOpen);
  const close = useDevinImportDialogStore((store) => store.closeDialog);
  const projects = useStore((store) => store.projects);

  const [sourceState, setSourceState] = useState<LoadState>("loading");
  const [sources, setSources] = useState<readonly ExternalHistorySourceDescriptor[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<LoadState>("loading");
  const [sessions, setSessions] = useState<readonly ExternalHistorySessionDescriptor[]>([]);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setProjectId((current) => current ?? projects[0]?.id ?? null);
    let cancelled = false;
    setSourceState("loading");
    const api = readNativeApi();
    if (!api) {
      setSourceState("error");
      return;
    }
    api.orchestration
      .listExternalHistorySources()
      .then((result) => {
        if (cancelled) return;
        setSources(result.sources);
        setSourceId((current) => current ?? result.sources[0]?.sourceId ?? null);
        setSourceState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setSourceState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [open, projects]);

  useEffect(() => {
    if (!open || sourceId === null) return;
    let cancelled = false;
    setSessionState("loading");
    const api = readNativeApi();
    if (!api) {
      setSessionState("error");
      return;
    }
    api.orchestration
      .listExternalHistorySessions({ sourceId })
      .then((result) => {
        if (cancelled) return;
        setSessions(result.sessions);
        setSessionState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setSessionState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [open, sourceId]);

  const busy = importingId !== null;
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? projects[0] ?? null,
    [projects, projectId],
  );

  const importSession = async (session: ExternalHistorySessionDescriptor) => {
    if (!selectedProject || busy) return;
    setError(null);
    setImportingId(session.externalSessionId);
    try {
      const projectModel = selectedProject.defaultModelSelection;
      const api = readNativeApi();
      if (!api) throw new Error(t("workspace:devinImport_sessionsLoadError"));
      const result = await api.orchestration.importExternalHistory({
        sourceId: session.sourceId,
        externalSessionId: session.externalSessionId,
        projectId: selectedProject.id,
        modelSelection:
          projectModel?.provider === "devin"
            ? projectModel
            : { provider: "devin", model: "adaptive" },
      });
      close();
      await navigate({
        to: "/$threadId",
        params: { threadId: result.threadId },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImportingId(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
    >
      <DialogPopup showCloseButton className="max-h-[min(640px,85dvh)] max-w-[560px]">
        <DialogHeader className="gap-1 px-5 pb-0 pt-5">
          <DialogTitle>{t("workspace:devinImport_title")}</DialogTitle>
          <DialogDescription className="text-ui">
            {t("workspace:devinImport_description")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-4 pt-3.5">
          {sourceState === "error" ? (
            <p className="text-ui-sm text-destructive">
              {t("workspace:devinImport_sourcesLoadError")}
            </p>
          ) : sourceState === "ready" && sources.length === 0 ? (
            <p className="text-ui-sm text-muted-foreground">
              {t("workspace:devinImport_noSources")}
            </p>
          ) : null}

          {sources.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {sources.map((source) => (
                <Button
                  key={source.sourceId}
                  size="sm"
                  variant={source.sourceId === sourceId ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => setSourceId(source.sourceId)}
                >
                  {t(SOURCE_KIND_LABEL_KEYS[source.kind] ?? "workspace:devinImport_sourceUnknown")}
                </Button>
              ))}
            </div>
          ) : null}

          {projects.length > 1 ? (
            <label className="text-ui-sm text-muted-foreground flex items-center gap-2">
              {t("workspace:devinImport_targetProject")}
              <select
                className="text-ui-sm border-border bg-background rounded-md border px-2 py-1"
                value={selectedProject?.id ?? ""}
                disabled={busy}
                onChange={(event) => setProjectId(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
            {sessionState === "loading" ? (
              <p className="text-ui-sm text-muted-foreground p-3">
                {t("workspace:devinImport_loading")}
              </p>
            ) : sessionState === "error" ? (
              <p className="text-ui-sm text-destructive p-3">
                {t("workspace:devinImport_sessionsLoadError")}
              </p>
            ) : sessions.length === 0 ? (
              <p className="text-ui-sm text-muted-foreground p-3">
                {t("workspace:devinImport_noSessions")}
              </p>
            ) : (
              <ul className="divide-border divide-y">
                {sessions.map((session) => (
                  <li
                    key={session.externalSessionId}
                    className="flex items-center justify-between gap-3 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-ui-sm truncate">
                        {session.title ?? session.externalSessionId}
                      </p>
                      <p className="text-ui-xs text-muted-foreground truncate">
                        {formatUpdatedAt(
                          session.originalUpdatedAt,
                          t("workspace:devinImport_unknownDate"),
                        )}
                        {session.workspaceHint ? ` · ${session.workspaceHint}` : ""}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || selectedProject === null}
                      onClick={() => void importSession(session)}
                    >
                      {importingId === session.externalSessionId
                        ? t("workspace:devinImport_importing")
                        : t("workspace:devinImport_import")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
