// FILE: BotMascotPicker.tsx
// Purpose: The bot editor's look: a live preview, the nine shapes (in the chosen color) and the
//          eight palette colors, each a keyboard radio group. "synara" is SynBot's own mark and is
//          never offered; SynBot's shape is fixed, only its color changes.
// Layer: SynBot editor UI
// Exports: BotMascotPicker, BOT_PICKER_SHAPES

import {
  BOT_MASCOT_COLORS,
  BOT_MASCOT_SHAPES,
  type BotMascot as BotMascotLook,
  type BotMascotShape,
} from "@synara/contracts";

import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";
import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";

import { BotMascot } from "../BotMascot";

/** Every shape a bot may take: all but SynBot's mark. */
export const BOT_PICKER_SHAPES: readonly BotMascotShape[] = BOT_MASCOT_SHAPES.filter(
  (shape) => shape !== "synara",
);

const SHAPE_LABEL_KEYS: Record<BotMascotShape, string> = {
  synara: "synbotEditor:shape_synara",
  circle: "synbotEditor:shape_circle",
  square: "synbotEditor:shape_square",
  pill: "synbotEditor:shape_pill",
  triangle: "synbotEditor:shape_triangle",
  hexagon: "synbotEditor:shape_hexagon",
  gem: "synbotEditor:shape_gem",
  clover: "synbotEditor:shape_clover",
  star: "synbotEditor:shape_star",
  drop: "synbotEditor:shape_drop",
};

/** Names of `BOT_MASCOT_COLORS`, in palette order. */
const COLOR_LABEL_KEYS: readonly string[] = [
  "synbotEditor:color_blue",
  "synbotEditor:color_orange",
  "synbotEditor:color_green",
  "synbotEditor:color_purple",
  "synbotEditor:color_red",
  "synbotEditor:color_teal",
  "synbotEditor:color_yellow",
  "synbotEditor:color_gray",
];

// One option tile: quiet until hovered, a hairline ring and soft fill when chosen.
function optionClassName(selected: boolean): string {
  return cn(
    "grid size-8 place-items-center rounded-lg border transition-colors motion-reduce:transition-none",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
    "disabled:cursor-default disabled:opacity-64",
    selected
      ? "border-foreground/40 bg-[var(--color-background-elevated-secondary)]"
      : "border-transparent hover:bg-[var(--color-background-elevated-secondary)]",
  );
}

export function BotMascotPicker(props: {
  readonly mascot: BotMascotLook;
  /** SynBot: the shape stays the Synara mark. */
  readonly shapeLocked: boolean;
  readonly onChange: (mascot: BotMascotLook) => void;
}) {
  const { t } = useTranslation();
  const { mascot, onChange } = props;
  const shapes = props.shapeLocked ? [mascot.shape] : BOT_PICKER_SHAPES;
  const shapeItemProps = useRadioGroupKeyboardNav({
    values: shapes,
    value: mascot.shape,
    onValueChange: (shape) => onChange({ ...mascot, shape }),
  });
  const colorItemProps = useRadioGroupKeyboardNav<string>({
    values: BOT_MASCOT_COLORS,
    value: mascot.color,
    onValueChange: (color) => onChange({ ...mascot, color }),
  });
  return (
    <div className="flex items-center gap-4">
      <BotMascot mascot={mascot} size="tile" className="size-14" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <div
          role="radiogroup"
          aria-label={t("synbotEditor:shape")}
          className="flex flex-wrap items-center gap-1"
        >
          {shapes.map((shape) => {
            const selected = shape === mascot.shape;
            const label = t(SHAPE_LABEL_KEYS[shape]);
            return (
              <button
                key={shape}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={label}
                title={label}
                disabled={props.shapeLocked}
                className={optionClassName(selected)}
                onClick={() => onChange({ ...mascot, shape })}
                {...shapeItemProps(shape)}
              >
                <BotMascot mascot={{ shape, color: mascot.color }} size="pill" still />
              </button>
            );
          })}
        </div>
        <div
          role="radiogroup"
          aria-label={t("synbotEditor:color")}
          className="flex flex-wrap items-center gap-1"
        >
          {BOT_MASCOT_COLORS.map((color, index) => {
            const selected = color.toLowerCase() === mascot.color.toLowerCase();
            const label = t(COLOR_LABEL_KEYS[index] ?? "synbotEditor:color");
            return (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={label}
                title={label}
                className={optionClassName(selected)}
                onClick={() => onChange({ ...mascot, color })}
                {...colorItemProps(color)}
              >
                <span className="size-4 rounded-full" style={{ background: color }} aria-hidden />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
