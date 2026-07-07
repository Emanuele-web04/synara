import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { EllipsisIcon, ListTodoIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: ProviderInteractionMode;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onToggleRuntimeMode: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="chrome"
            className="shrink-0 px-2"
            aria-label={t("chat.composerControls.moreControls")}
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>{t("chat.composerControls.mode")}</MenuGroupLabel>
          <MenuRadioGroup
            value={props.interactionMode}
            onValueChange={(value) => {
              if (!value || value === props.interactionMode) return;
              props.onToggleInteractionMode();
            }}
          >
            <MenuRadioItem value="default">{t("chat.composerControls.build")}</MenuRadioItem>
            <MenuRadioItem value="plan">{t("chat.composerControls.plan")}</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? t("chat.composerControls.hidePlanSidebar")
                : t("chat.composerControls.showPlanSidebar")}
            </MenuItem>
          </>
        ) : null}
      </ComposerPickerMenuPopup>
    </Menu>
  );
});
