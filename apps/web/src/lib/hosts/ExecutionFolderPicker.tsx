import { t as translate, useTranslation } from "~/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "@synara/contracts";
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
  browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
};

export function ExecutionFolderPicker({
  label,
  browse,
  onClose,
}: PickerOptions & { onClose: (path: string | null) => void }) {
  const { t } = useTranslation();
  const pathId = useId();
  useEffect(() => {
    notifyNativeSurfaceOcclusionChange();
  }, []);
  const [path, setPath] = useState("~/");
  const pathRevision = useRef(0);
  const [requested, setRequested] = useState({ path: "~/" });
  const [listing, setListing] = useState<FilesystemBrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const revision = pathRevision.current;
    void browse({ partialPath: requested.path }).then(
      (result) => {
        if (cancelled) return;
        setListing(result);
        // A slow listing must not overwrite a path the user has started typing.
        if (pathRevision.current === revision) setPath(result.parentPath);
      },
      (cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : translate("computer:remote_host_read_folder_failed"),
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [browse, requested]);
  const openFolder = (value: string) => {
    pathRevision.current += 1;
    setListing(null);
    setError(null);
    setRequested({ path: `${value.replace(/[\\/]+$/, "")}/` });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose(null);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("computer:remote_host_choose_folder_on", { host: label })}</DialogTitle>
          <DialogDescription>{t("computer:remote_host_existing_folder")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              openFolder(path);
            }}
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <label htmlFor={pathId} className="text-ui-sm text-muted-foreground">
                {t("computer:remote_host_folder_path")}
              </label>
              <Input
                id={pathId}
                value={path}
                onChange={(event) => {
                  pathRevision.current += 1;
                  setPath(event.target.value);
                }}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <Button type="submit" variant="outline" disabled={!path.trim()}>
              {t("computer:remote_host_go")}
            </Button>
          </form>
          <div className="flex items-center justify-between gap-2">
            <p
              className="min-w-0 truncate text-ui-sm text-muted-foreground"
              title={listing?.parentPath}
            >
              {listing?.parentPath ??
                (error
                  ? t("workspace:folderUnavailable")
                  : t("workspace:projectPicker_loadingFolders"))}
            </p>
            <Button
              variant="ghost"
              size="sm"
              disabled={!listing || /^[\\/]+$|^[A-Za-z]:[\\/]?$/.test(listing.parentPath)}
              onClick={() => listing && openFolder(`${listing.parentPath}/..`)}
            >
              {t("computer:remote_host_up")}
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          ) : null}
          <div
            className="h-64 overflow-y-auto rounded-xl border border-border"
            aria-label={t("computer:remote_host_folders_on", { host: label })}
            aria-busy={!listing && !error}
          >
            {listing?.entries.map((entry) => (
              <button
                key={entry.fullPath}
                type="button"
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-ui text-foreground outline-none hover:bg-accent focus-visible:bg-accent"
                onClick={() => openFolder(entry.fullPath)}
              >
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
            {listing?.entries.length === 0 ? (
              <p className="px-3 py-4 text-ui text-muted-foreground">
                {t("computer:remote_host_no_subfolders")}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(null)}>
            {t("common:form_cancel")}
          </Button>
          <Button
            disabled={!listing || Boolean(error) || path.trim() !== listing.parentPath}
            onClick={() => listing && onClose(listing.parentPath)}
          >
            {t("computer:remote_host_use_folder")}
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
