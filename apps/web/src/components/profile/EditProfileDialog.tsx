// FILE: EditProfileDialog.tsx
// Purpose: "Edit profile" modal — edits the local display name, @handle, avatar photo, and
// accent color. The photo is compressed on-device before it's handed back. Drafts are held
// locally and only committed on Save.
// Layer: web profile feature (all changes persist to localStorage via the parent hooks).

import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "~/components/ui/input-group";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { normalizeHandle } from "./profileFormatting";
import { PROFILE_AVATAR_COLORS } from "./useProfileAvatarColor";
import { AvatarImageError, compressAvatarImage } from "./avatarImage";
import { ProfileAvatar } from "./ProfileAvatar";

// Inputs and footer buttons share one fixed height + radius so every control in
// the dialog reads as the same size. The visible border keeps the fields legible
// even when unfocused (the default --input border is ~6% and reads as "no box").
const fieldControlClassName = "h-9 rounded-xl border-foreground/12";
const dialogButtonClassName = "h-11 rounded-lg px-4";

interface EditProfileDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initials: string;
  readonly name: string;
  readonly handle: string;
  readonly avatarColor: string;
  readonly avatarImage: string | null;
  readonly onSave: (next: {
    name: string;
    handle: string;
    avatarColor: string;
    avatarImage: string | null;
  }) => void;
}

export function EditProfileDialog({
  open,
  onOpenChange,
  initials,
  name,
  handle,
  avatarColor,
  avatarImage,
  onSave,
}: EditProfileDialogProps) {
  const [draftName, setDraftName] = useState(name);
  const [draftHandle, setDraftHandle] = useState(handle.replace(/^@+/, ""));
  const [draftColor, setDraftColor] = useState(avatarColor);
  const [draftImage, setDraftImage] = useState<string | null>(avatarImage);
  const [showEditor, setShowEditor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  // Re-seed drafts from the live values whenever the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setDraftName(name);
      setDraftHandle(handle.replace(/^@+/, ""));
      setDraftColor(avatarColor);
      setDraftImage(avatarImage);
      setShowEditor(false);
      setError(null);
      setProcessing(false);
    }
  }, [open, name, handle, avatarColor, avatarImage]);

  const handlePickFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setError(null);
    setProcessing(true);
    try {
      setDraftImage(await compressAvatarImage(file));
    } catch (cause) {
      setError(
        cause instanceof AvatarImageError
          ? t(cause.i18nKey)
          : t("profile.edit.couldNotProcessImage"),
      );
    } finally {
      setProcessing(false);
    }
  };

  const handleSave = () => {
    onSave({
      name: draftName.trim(),
      handle: normalizeHandle(draftHandle),
      avatarColor: draftColor,
      avatarImage: draftImage,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup surface="solid" showCloseButton={false} className="sm:max-w-[500px]">
        <DialogTitle className="px-4 pt-4 text-lg">{t("profile.edit.title")}</DialogTitle>

        <div className="flex flex-col gap-4 px-4 pt-3">
          {/* Avatar */}
          <div className="flex flex-col items-center gap-3">
            <div className="relative">
              <ProfileAvatar
                initials={initials}
                color={draftColor}
                image={draftImage}
                className="size-20"
                textClassName="text-2xl"
              />
              <button
                type="button"
                onClick={() => setShowEditor((value) => !value)}
                aria-label={t("profile.edit.editAvatar")}
                className={cn(
                  "absolute bottom-0 end-0 flex size-7 items-center justify-center rounded-full",
                  "bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/60",
                )}
              >
                <CentralIcon name="pencil" className="size-3 opacity-100" />
              </button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                void handlePickFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />

            {showEditor && (
              <div className="flex flex-col items-center gap-3">
                <div className="flex items-center justify-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="gap-1.5"
                    disabled={processing}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <CentralIcon name="add-image" className="size-3.5" />
                    {processing
                      ? t("profile.edit.processing")
                      : draftImage
                        ? t("profile.edit.replacePhoto")
                        : t("profile.edit.uploadPhoto")}
                  </Button>
                  {draftImage && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="gap-1.5 text-muted-foreground"
                      onClick={() => {
                        setDraftImage(null);
                        setError(null);
                      }}
                    >
                      <CentralIcon name="trash-can-simple" className="size-3.5" />
                      {t("profile.edit.remove")}
                    </Button>
                  )}
                </div>

                <div className="flex items-center justify-center gap-2">
                  {PROFILE_AVATAR_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setDraftColor(color)}
                      aria-label={t("profile.edit.useColor", { color })}
                      className={cn(
                        "size-5 rounded-full transition-transform hover:scale-110",
                        !draftImage &&
                          draftColor === color &&
                          "ring-2 ring-foreground/70 ring-offset-2 ring-offset-popover",
                      )}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>

                {draftImage && (
                  <p className="text-center text-xs text-muted-foreground">
                    {t("profile.edit.colorsApplyInfo")}
                  </p>
                )}
              </div>
            )}

            {error && <p className="text-center text-xs text-destructive">{error}</p>}
          </div>

          {/* Fields */}
          <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
            <Field label={t("profile.edit.displayName")}>
              <InputGroup className={fieldControlClassName}>
                <InputGroupInput
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  placeholder={t("profile.edit.yourName")}
                />
              </InputGroup>
            </Field>
            <Field label={t("profile.edit.username")}>
              <InputGroup className={fieldControlClassName}>
                <InputGroupAddon>
                  <InputGroupText>@</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  value={draftHandle}
                  onChange={(event) =>
                    setDraftHandle(event.target.value.replace(/^@+/, "").replace(/\s+/g, ""))
                  }
                  placeholder={t("profile.edit.username")}
                />
              </InputGroup>
            </Field>
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 px-4 pb-4 pt-4 sm:flex-row sm:justify-end">
          <DialogClose
            render={<Button variant="ghost" size="default" className={dialogButtonClassName} />}
          >
            {t("profile.edit.cancel")}
          </DialogClose>
          <Button
            variant="default"
            size="default"
            className={dialogButtonClassName}
            onClick={handleSave}
            disabled={processing}
          >
            {t("profile.edit.save")}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-3">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="w-56 shrink-0">{children}</div>
    </div>
  );
}
