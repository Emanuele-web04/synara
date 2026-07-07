import { useTranslation } from "react-i18next";
import { RenameDialog } from "./RenameDialog";

interface RenameThreadDialogProps {
  open: boolean;
  currentTitle: string;
  onOpenChange: (open: boolean) => void;
  onSave: (newTitle: string) => Promise<void> | void;
}

export function RenameThreadDialog({
  open,
  currentTitle,
  onOpenChange,
  onSave,
}: RenameThreadDialogProps) {
  const { t } = useTranslation();
  return (
    <RenameDialog
      open={open}
      title={t("sidebar.renameChat")}
      description={t("sidebar.renameChatDescription")}
      initialValue={currentTitle}
      onOpenChange={onOpenChange}
      onSave={onSave}
    />
  );
}
