// FILE: MascotPicker.tsx
// Purpose: A bot's look: one row of shapes in the chosen color, one row of colors. Shared by the
//          bot sheet (edit) and the New bot steps.
// Layer: SynBot editor UI
// Exports: MascotPicker

import { BOT_MASCOT_COLORS, BOT_MASCOT_SHAPES, type BotMascot } from "@synara/contracts";

import { useTranslation } from "~/i18n";

import { BotMascot as MascotGlyph } from "../kit/Mascot";

/** Every shape a bot may take: all but SynBot's reserved mark. */
const PICKER_SHAPES = BOT_MASCOT_SHAPES.filter((shape) => shape !== "synara");
const COLOR_KEYS = ["blue", "orange", "green", "purple", "red", "teal", "yellow", "gray"] as const;

export function MascotPicker({
  mascot,
  onChange,
}: {
  readonly mascot: BotMascot;
  readonly onChange: (mascot: BotMascot) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="bot-sheet__pickers">
      <div className="bot-sheet__row" role="radiogroup" aria-label={t("synbotEditor:shape")}>
        {PICKER_SHAPES.map((shape) => (
          <button
            key={shape}
            type="button"
            role="radio"
            aria-checked={mascot.shape === shape}
            aria-label={t(`synbotEditor:shape_${shape}`)}
            title={t(`synbotEditor:shape_${shape}`)}
            className="bot-sheet__swatch"
            onClick={() => onChange({ ...mascot, shape })}
          >
            <MascotGlyph shape={shape} color={mascot.color} size={22} still />
          </button>
        ))}
      </div>
      <div className="bot-sheet__row" role="radiogroup" aria-label={t("synbotEditor:color")}>
        {BOT_MASCOT_COLORS.map((color, index) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={mascot.color === color}
            aria-label={t(`synbotEditor:color_${COLOR_KEYS[index] ?? "gray"}`)}
            title={t(`synbotEditor:color_${COLOR_KEYS[index] ?? "gray"}`)}
            className="bot-sheet__color"
            style={{ background: color }}
            onClick={() => onChange({ ...mascot, color })}
          />
        ))}
      </div>
    </div>
  );
}
