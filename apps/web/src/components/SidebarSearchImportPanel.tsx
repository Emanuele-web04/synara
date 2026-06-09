// Purpose: Import-mode panel for the sidebar search palette. Owns the provider
// selection + session-id entry flow so the palette container only toggles modes.
import { type ProviderKind } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { LuArrowLeft } from "react-icons/lu";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ProviderIcon } from "./SidebarSearchPalette.parts";

export type ImportProviderKind = Extract<
  ProviderKind,
  "codex" | "claudeAgent" | "cursor" | "kilo" | "opencode"
>;

function providerLabel(provider: ImportProviderKind): string {
  switch (provider) {
    case "claudeAgent":
      return "Claude";
    case "cursor":
      return "Cursor";
    case "kilo":
      return "Kilo";
    case "opencode":
      return "OpenCode";
    default:
      return "Codex";
  }
}

function importPlaceholderFor(provider: ImportProviderKind): string {
  switch (provider) {
    case "claudeAgent":
      return "Paste a Claude session id";
    case "cursor":
      return "Paste a Cursor session id";
    case "kilo":
      return "Paste a Kilo session id";
    case "opencode":
      return "Paste an OpenCode session id";
    default:
      return "Paste a Codex thread id";
  }
}

function importHintFor(provider: ImportProviderKind): string {
  switch (provider) {
    case "claudeAgent":
      return "Claude resumes a persisted session by session id.";
    case "cursor":
      return "Cursor resumes a persisted session by session id.";
    case "kilo":
      return "Kilo resumes a persisted session by session id.";
    case "opencode":
      return "OpenCode resumes a persisted session by session id.";
    default:
      return "Codex resumes a persisted thread by thread id.";
  }
}

interface SidebarSearchImportPanelProps {
  open: boolean;
  importProviders: readonly ImportProviderKind[];
  onModeChange: (mode: "search") => void;
  onOpenChange: (open: boolean) => void;
  onImportThread: (provider: ImportProviderKind, externalId: string) => Promise<void>;
}

export function SidebarSearchImportPanel(props: SidebarSearchImportPanelProps) {
  const [importProvider, setImportProvider] = useState<ImportProviderKind>(
    props.importProviders[0] ?? "codex",
  );
  const [importId, setImportId] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  useEffect(() => {
    if (!props.open) {
      setImportProvider(props.importProviders[0] ?? "codex");
      setImportId("");
      setImportError(null);
      setIsImporting(false);
    }
  }, [props.importProviders, props.open]);

  useEffect(() => {
    if (props.importProviders.includes(importProvider)) {
      return;
    }
    setImportProvider(props.importProviders[0] ?? "codex");
  }, [importProvider, props.importProviders]);

  const importFieldLabel = importProvider === "codex" ? "Thread ID" : "Session ID";

  const submitImport = async () => {
    const normalizedImportId = importId.trim();
    if (!normalizedImportId || isImporting) {
      return;
    }
    setImportError(null);
    setIsImporting(true);
    try {
      await props.onImportThread(importProvider, normalizedImportId);
      props.onOpenChange(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Failed to import thread.");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="flex flex-col overflow-hidden">
      <div className="border-b border-border/70 px-4 py-3">
        <div className="flex items-start gap-3">
          <Button
            size="icon"
            variant="ghost"
            className="-ml-1 mt-[-2px] size-8 shrink-0"
            onClick={() => {
              setImportError(null);
              props.onModeChange("search");
            }}
          >
            <LuArrowLeft className="size-4" />
          </Button>
          <div>
            <p className="text-sm font-medium text-foreground">Import thread from provider</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create a local app thread and resume it from an existing provider id.
            </p>
          </div>
        </div>
      </div>
      <div className="space-y-4 px-4 py-4">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Provider
          </p>
          <div className="flex gap-2">
            {props.importProviders.map((provider) => (
              <Button
                key={provider}
                className={
                  importProvider === provider
                    ? "flex-1 justify-start border-border bg-muted text-foreground hover:bg-muted/80"
                    : "flex-1 justify-start"
                }
                variant="outline"
                onClick={() => setImportProvider(provider)}
              >
                <ProviderIcon provider={provider} />
                {providerLabel(provider)}
              </Button>
            ))}
          </div>
          {props.importProviders.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No connected providers expose chat import in this build.
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {importFieldLabel}
          </p>
          <Input
            autoFocus
            nativeInput
            placeholder={importPlaceholderFor(importProvider)}
            value={importId}
            disabled={props.importProviders.length === 0}
            onChange={(event) => setImportId(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitImport();
              }
            }}
          />
          <p className="text-xs text-muted-foreground">{importHintFor(importProvider)}</p>
        </div>
        {importError ? (
          <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {importError}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setImportError(null);
              props.onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={
              props.importProviders.length === 0 || importId.trim().length === 0 || isImporting
            }
            onClick={submitImport}
          >
            {isImporting ? "Importing..." : "Import"}
          </Button>
        </div>
      </div>
    </div>
  );
}
