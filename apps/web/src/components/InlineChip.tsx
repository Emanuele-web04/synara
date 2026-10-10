import type { ReactNode } from "react";
import { COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME } from "./composerInlineChip";

export function InlineChipContent(props: { icon: ReactNode; label: ReactNode }) {
  return (
    <>
      {props.icon}
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
    </>
  );
}
