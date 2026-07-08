import { ProviderInteractionMode, RuntimeMode } from "@synara/contracts";
import { memo, type ReactNode } from "react";
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
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="chrome"
            className="shrink-0 px-2"
            aria-label="More composer controls"
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
          <MenuGroupLabel>Mode</MenuGroupLabel>
          <MenuRadioGroup
            value={props.interactionMode}
            onValueChange={(value) => {
              if (!value || value === props.interactionMode) return;
              props.onToggleInteractionMode();
            }}
          >
            <MenuRadioItem value="default">Build</MenuRadioItem>
            <MenuRadioItem value="plan">Plan</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"}
            </MenuItem>
          </>
        ) : null}
      </ComposerPickerMenuPopup>
    </Menu>
  );
});
