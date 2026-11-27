import type { CanvasFolder, ProjectId } from "@synara/contracts";
import { useState } from "react";
import { useTranslation } from "~/i18n";
import { CanvasIcon, FolderIcon } from "~/lib/icons";
import { useStore } from "~/store";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
  dialogFieldLabelClassName,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
  SelectSeparator,
} from "../ui/select";
import { canvasFolderRowIndent, canvasFolderTree } from "./canvasFolderTree";

export type CanvasResourceFields = {
  title: string;
  folderId: string | null;
  projectId: ProjectId | null;
};

/** Creation and organization share the existing dialog and form primitives. */
export function CanvasResourceDialog({
  title,
  initial,
  folders,
  work,
  onClose,
  onSave,
}: {
  title: string;
  initial: CanvasResourceFields;
  folders: readonly CanvasFolder[];
  work: boolean;
  onClose: () => void;
  onSave: (fields: CanvasResourceFields) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [fields, setFields] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projects = useStore((state) => state.projects);
  const tree = canvasFolderTree(folders);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !fields.title.trim()) return;
            setBusy(true);
            setError(null);
            void onSave({ ...fields, title: fields.title.trim() })
              .then(onClose)
              .catch((cause: unknown) =>
                setError(
                  cause instanceof Error ? cause.message : t("workspace:canvasOperationFailed"),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <label className="block space-y-2">
              <span className={dialogFieldLabelClassName}>{t("workspace:canvasName")}</span>
              <Input
                autoFocus
                value={fields.title}
                maxLength={120}
                required
                onChange={(event) => setFields({ ...fields, title: event.target.value })}
              />
            </label>
            <div className="space-y-2">
              <span className={dialogFieldLabelClassName}>{t("workspace:canvasFolder")}</span>
              <Select
                value={fields.folderId ?? ""}
                onValueChange={(value) => setFields({ ...fields, folderId: value || null })}
                items={[
                  { value: "", label: t("workspace:canvasFiles") },
                  ...folders.map((folder) => ({ value: folder.id, label: folder.title })),
                ]}
              >
                <SelectTrigger aria-label={t("workspace:canvasFolder")}>
                  <SelectValue />
                </SelectTrigger>
                {/* Folders as their tree, as the library's Move to menu lists them. */}
                <SelectPopup surface="composer">
                  <SelectItem value="">
                    <span className="flex items-center gap-2">
                      <CanvasIcon className="size-3.5 shrink-0 opacity-70" />
                      {t("workspace:canvasFiles")}
                    </span>
                  </SelectItem>
                  {tree.length > 0 && <SelectSeparator />}
                  {tree.map(({ folder, depth }) => (
                    <SelectItem
                      key={folder.id}
                      value={folder.id}
                      data-folder-depth={depth}
                      // A select row's own start padding is `px-2.5`.
                      style={canvasFolderRowIndent(depth, "calc(var(--spacing) * 2.5)")}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <FolderIcon className="size-3.5 shrink-0 opacity-70" />
                        <span className="truncate">{folder.title}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {work && (
              <div className="space-y-2">
                <span className={dialogFieldLabelClassName}>{t("workspace:canvasProject")}</span>
                <Select
                  value={fields.projectId ?? ""}
                  onValueChange={(value) =>
                    setFields({ ...fields, projectId: (value || null) as ProjectId | null })
                  }
                  items={[
                    { value: "", label: t("workspace:canvasStandalone") },
                    ...projects
                      .filter((project) => project.kind !== "chat")
                      .map((project) => ({ value: project.id, label: project.name })),
                  ]}
                >
                  <SelectTrigger aria-label={t("workspace:canvasProject")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup surface="composer">
                    <SelectItem value="">{t("workspace:canvasStandalone")}</SelectItem>
                    {projects
                      .filter((project) => project.kind !== "chat")
                      .map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                  </SelectPopup>
                </Select>
              </div>
            )}
            {error && (
              <p className="text-ui-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t("common:form_cancel")}
            </Button>
            <Button type="submit" disabled={busy || !fields.title.trim()}>
              {t("computer:form_save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
