// FILE: MascotPicker.tsx
// Purpose: A bot's look: one row of outfits in the chosen color, one row of colors. Shared by the
//          bot sheet (edit) and the New bot steps. Each row is a radio group: Tab reaches the
//          chosen one, the arrow keys move the choice (Synara's useRadioGroupKeyboardNav).
// Layer: SynBot editor UI
// Exports: MascotPicker

import {
  BOT_MASCOT_COLORS,
  BOT_MASCOT_SHAPES,
  type BotMascot,
  type BotMascotShape,
} from "@synara/contracts";

import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";
import { useTranslation } from "~/i18n";

import { BotMascot as MascotGlyph } from "../kit/Mascot";

/** Every outfit a bot may take: all but SynBot's reserved captain. */
const PICKER_OUTFITS = BOT_MASCOT_SHAPES.filter((shape) => shape !== "synara");
const COLOR_KEYS = ["blue", "orange", "green", "purple", "red", "teal", "yellow", "gray"] as const;

/** The roving tab stop: the chosen item, or the first one when the choice is not in the row. */
function tabStop<T extends string>(values: readonly T[], value: T, item: T, tabIndex: number) {
  if (values.includes(value)) return tabIndex;
  return item === values[0] ? 0 : -1;
}

export function MascotPicker({
  mascot,
  onChange,
}: {
  readonly mascot: BotMascot;
  readonly onChange: (mascot: BotMascot) => void;
}) {
  const { t } = useTranslation();
  const shapeItem = useRadioGroupKeyboardNav<BotMascotShape>({
    values: PICKER_OUTFITS,
    value: mascot.shape,
    onValueChange: (shape) => onChange({ ...mascot, shape }),
  });
  const colorItem = useRadioGroupKeyboardNav<string>({
    values: BOT_MASCOT_COLORS,
    value: mascot.color,
    onValueChange: (color) => onChange({ ...mascot, color }),
  });
  return (
    <div className="bot-sheet__pickers">
      <div className="bot-sheet__row" role="radiogroup" aria-label={t("synbotEditor:shape")}>
        {PICKER_OUTFITS.map((shape) => {
          const item = shapeItem(shape);
          return (
            <button
              key={shape}
              type="button"
              role="radio"
              aria-checked={mascot.shape === shape}
              aria-label={t(`synbotEditor:shape_${shape}`)}
              title={t(`synbotEditor:shape_${shape}`)}
              className="bot-sheet__swatch"
              ref={item.ref}
              tabIndex={tabStop(PICKER_OUTFITS, mascot.shape, shape, item.tabIndex)}
              onKeyDown={item.onKeyDown}
              onClick={() => onChange({ ...mascot, shape })}
            >
              <MascotGlyph shape={shape} color={mascot.color} size={22} still />
            </button>
          );
        })}
      </div>
      <div className="bot-sheet__row" role="radiogroup" aria-label={t("synbotEditor:color")}>
        {BOT_MASCOT_COLORS.map((color, index) => {
          const item = colorItem(color);
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={mascot.color === color}
              aria-label={t(`synbotEditor:color_${COLOR_KEYS[index] ?? "gray"}`)}
              title={t(`synbotEditor:color_${COLOR_KEYS[index] ?? "gray"}`)}
              className="bot-sheet__color"
              style={{ background: color }}
              ref={item.ref}
              tabIndex={tabStop(BOT_MASCOT_COLORS, mascot.color, color, item.tabIndex)}
              onKeyDown={item.onKeyDown}
              onClick={() => onChange({ ...mascot, color })}
            />
          );
        })}
      </div>
    </div>
  );
}
