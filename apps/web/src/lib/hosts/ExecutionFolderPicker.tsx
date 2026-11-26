import { useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemCreateFolderInput,
} from "@synara/contracts";
import { normalizeProjectDirectoryName } from "@synara/shared/projectDirectoryName";
import { t } from "~/i18n";
import { FolderPathInput } from "./FolderPathInput";
import { hasTrailingPathSeparator, preferredPathSeparator } from "../projectPaths";
import { describeErrorMessage } from "@synara/shared/errorMessages";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { FolderIcon } from "~/lib/icons";
import { notifyNativeSurfaceOcclusionChange } from "../nativeSurfaceOcclusion";

type PickerOptions = {
  label: string;
  createFolder?: ((input: FilesystemCreateFolderInput) => Promise<string>) | undefined;
  browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
};

export function ExecutionFolderPicker({
  label,
  browse,
  createFolder,
  onClose,
}: PickerOptions & { onClose: (path: string | null) => void }) {
  const pathId = useId();
  useEffect(() => {
    notifyNativeSurfaceOcclusionChange();
  }, []);
  const [path, setPath] = useState("~/");
  const [folderName, setFolderName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const pathRevision = useRef(0);
  const [requested, setRequested] = useState<FilesystemBrowseInput>({ partialPath: "~/" });
  const [listing, setListing] = useState<FilesystemBrowseResult | null>(null);
  // A failed folder returns to the last readable one so Up and its folders stay usable.
  const lastListing = useRef<FilesystemBrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const revision = pathRevision.current;
    void browse(requested).then(
      (result) => {
        if (cancelled) return;
        lastListing.current = result;
        setListing(result);
        // A slow listing must not overwrite a path the user has started typing.
        if (pathRevision.current === revision) setPath(result.parentPath);
      },
      (cause: unknown) => {
        // A remote host's browse runs in its workspace frame, so its Error fails a
        // parent-realm `instanceof`; RPC defects also arrive as plain strings.
        if (cancelled) return;
        setListing(lastListing.current);
        setError(
          describeErrorMessage(
            cause,
            "Cannot read this folder. Check the connection and try again.",
          ),
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [browse, requested]);
  const requestFolder = (input: FilesystemBrowseInput) => {
    pathRevision.current += 1;
    setListing(null);
    setFolderName(null);
    setError(null);
    setRequested(input);
  };
  const openFolder = (absolutePath: string) =>
    requestFolder({
      partialPath: hasTrailingPathSeparator(absolutePath)
        ? absolutePath
        : absolutePath + preferredPathSeparator(absolutePath),
    });
  const cwd = listing?.parentPath ?? requested.cwd ?? "~/";
  // A final slash requests the directory itself, not a list of prefix matches. The host
  // interprets the typed path (including any backslashes) using its own path rules.
  const openTypedFolder = () =>
    requestFolder({ partialPath: path.endsWith("/") ? path : path + "/", cwd });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !creating) onClose(null);
      }}
    >
      <DialogPopup showCloseButton={!creating}>
        <DialogHeader>
          <DialogTitle>Choose a folder on {label}</DialogTitle>
          <DialogDescription>
            {createFolder
              ? t("workspace:folderPickerDescription")
              : t("workspace:folderPickerBrowseOnlyDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              openTypedFolder();
            }}
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <label htmlFor={pathId} className="text-ui-sm text-muted-foreground">
                Folder path
              </label>
              <FolderPathInput
                browse={browse}
                cwd={cwd}
                disabled={creating}
                id={pathId}
                value={path}
                onChange={(next) => {
                  pathRevision.current += 1;
                  setPath(next);
                  setFolderName(null);
                }}
                onEnter={(event) => {
                  event.preventDefault();
                  if (path.trim()) openTypedFolder();
                }}
              />
            </div>
            <Button type="submit" variant="outline" disabled={creating || !path.trim()}>
              Go
            </Button>
          </form>
          <div className="flex items-center justify-between gap-2">
            <p
              className="min-w-0 truncate text-ui-sm text-muted-foreground"
              title={listing?.parentPath}
            >
              {listing?.parentPath ?? (error ? "Folder unavailable" : "Loading folders…")}
            </p>
            {createFolder && (
              <Button
                variant="outline"
                size="sm"
                disabled={creating || !listing || path !== listing.parentPath}
                onClick={() => {
                  setFolderName("");
                  setError(null);
                }}
              >
                {t("workspace:pickerNewFolder")}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={
                creating || !listing || /^[\\/]+$|^[A-Za-z]:[\\/]?$/.test(listing.parentPath)
              }
              onClick={() => listing && openFolder(`${listing.parentPath}/..`)}
            >
              Up
            </Button>
          </div>
          {folderName !== null && listing && createFolder && (
            <form
              className="flex items-center gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                if (creating) return;
                const name = normalizeProjectDirectoryName(folderName);
                if (!name) {
                  setError(t("workspace:chooseAValidFolderNameWithoutSlashesReservedDevice"));
                  return;
                }
                setCreating(true);
                setError(null);
                try {
                  const created = await createFolder({ parentPath: listing.parentPath, name });
                  openFolder(created);
                } catch (cause) {
                  setError(describeErrorMessage(cause, t("workspace:pickerCreateFolderFailed")));
                }
                setCreating(false);
              }}
            >
              <Input
                autoFocus
                aria-label={t("workspace:pickerFolderName")}
                placeholder={t("workspace:pickerFolderName")}
                value={folderName}
                disabled={creating}
                onChange={(event) => {
                  setFolderName(event.target.value);
                  setError(null);
                }}
              />
              <Button type="submit" variant="outline" disabled={creating || !folderName.trim()}>
                {t("workspace:pickerCreateFolder")}
              </Button>
            </form>
          )}
          {error ? (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          ) : null}
          <div
            className="h-64 overflow-y-auto rounded-xl border border-border"
            aria-label={`Folders on ${label}`}
            aria-busy={!listing && !error}
          >
            {listing?.entries.map((entry) => (
              <button
                key={entry.fullPath}
                type="button"
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-ui text-foreground outline-none hover:bg-accent focus-visible:bg-accent"
                disabled={creating}
                onClick={() => openFolder(entry.fullPath)}
              >
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
            {listing?.entries.length === 0 ? (
              <p className="px-3 py-4 text-ui text-muted-foreground">
                No subfolders. You can select this folder.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={creating} onClick={() => onClose(null)}>
            Cancel
          </Button>
          <Button
            disabled={creating || !listing || path !== listing.parentPath}
            onClick={() => listing && onClose(listing.parentPath)}
          >
            Use folder
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

let openPicker = false;
export function showExecutionFolderPicker(options: PickerOptions): Promise<string | null> {
  if (openPicker) return Promise.reject(new Error("A folder picker is already open"));
  openPicker = true;
  const previousFocus = document.activeElement;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return new Promise((resolve) => {
    let closed = false;
    root.render(
      <ExecutionFolderPicker
        {...options}
        onClose={(value) => {
          if (closed) return;
          closed = true;
          queueMicrotask(() => {
            root.unmount();
            container.remove();
            openPicker = false;
            notifyNativeSurfaceOcclusionChange();
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
              previousFocus.focus();
            resolve(value);
          });
        }}
      />,
    );
    notifyNativeSurfaceOcclusionChange();
  });
}
