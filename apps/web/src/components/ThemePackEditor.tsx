// FILE: ThemePackEditor.tsx
// Purpose: Per-variant theme card matching the Codex appearance settings layout.
// Layer: Web settings UI
// Exports: ThemePackEditor

import { useId, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";
import { type ChromeTheme, type ThemeMode, type ThemeVariant, useTheme } from "../hooks/useTheme";
import { cn } from "../lib/utils";
import {
  CODE_THEME_OPTIONS,
  DEFAULT_THEME_STATE,
  getAvailableCodeThemes,
  getCodeThemeSeed,
  resolveThemePack,
} from "../theme/theme.logic";

type ThemePackEditorProps = {
  isActive?: boolean;
  mode?: ThemeMode;
  variant: ThemeVariant;
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function ThemePackEditor({
  variant,
  isActive = false,
  mode = "system",
}: ThemePackEditorProps) {
  const {
    darkTheme,
    lightTheme,
    exportThemeString,
    importThemeString,
    isDefaultThemePack,
    resetThemeVariant,
    setCodeThemeId,
    updateThemePack,
    updateThemeFonts,
  } = useTheme();

  const pack = variant === "dark" ? darkTheme : lightTheme;
  const theme = pack.theme;
  const defaultTheme = resolveThemePack(DEFAULT_THEME_STATE, variant).theme;
  const codeThemes = useMemo(() => {
    const options = getAvailableCodeThemes(variant);
    return options.map((option) => ({
      id: option.id,
      label: option.label,
      previewTheme: getCodeThemeSeed(option.id, variant),
      variants: option.variants,
    }));
  }, [variant]);
  const codeThemeLabel =
    CODE_THEME_OPTIONS.find((option) => option.id === pack.codeThemeId)?.label ?? pack.codeThemeId;
  const isPristine = isDefaultThemePack(variant);
  const titleLabel = variant === "dark" ? "Dark theme" : "Light theme";
  const contextLabel = isActive
    ? mode === "system"
      ? `System is currently using this ${variant} slot.`
      : "This is the active theme right now."
    : mode === "system"
      ? `Used when your system switches to ${variant}.`
      : `Inactive while the app is locked to ${mode}.`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportThemeString(variant));
      toastManager.add({
        type: "success",
        title: "Theme copied",
        description: `Copied the ${variant} theme share string.`,
      });
    } catch {
      toastManager.add({
        type: "error",
        title: "Copy failed",
        description: "Unable to copy the theme share string.",
      });
    }
  };

  const handleImport = (value: string) => {
    importThemeString(value, variant);
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-[color:var(--color-border)] bg-[var(--color-background-panel)] shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:py-3.5">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">{titleLabel}</h3>
          <ThemeSlotBadge isActive={isActive} mode={mode} variant={variant} />
          {!isPristine ? (
            <button
              type="button"
              onClick={() => resetThemeVariant(variant)}
              className="rounded-sm px-1.5 py-0.5 text-[11px] text-[var(--color-text-foreground-secondary)] transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-[var(--color-text-foreground)]"
            >
              Reset
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <ImportThemeDialog variant={variant} onImport={handleImport} />
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="rounded-md px-2 py-1 text-xs text-[var(--color-text-foreground-secondary)] transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-[var(--color-text-foreground)]"
          >
            Copy JSON
          </button>
          <Select
            value={pack.codeThemeId}
            onValueChange={(value) => {
              if (typeof value !== "string") return;
              setCodeThemeId(variant, value);
            }}
          >
            <SelectTrigger
              size="sm"
              className="ml-1 min-w-52 gap-2"
              aria-label={`${titleLabel} code theme`}
            >
              <SelectValue className="flex-1 text-left">
                <CodeThemeSelectOption label={codeThemeLabel} theme={theme} />
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false} className="p-1.5">
              {codeThemes.map((option) => (
                <SelectItem
                  hideIndicator
                  key={option.id}
                  value={option.id}
                  className="rounded-lg px-2 py-2"
                >
                  <CodeThemeSelectOption label={option.label} theme={option.previewTheme} />
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      <div className="px-4 pb-3 text-[11px] text-[var(--color-text-foreground-secondary)] sm:px-4">
        {contextLabel}
      </div>

      <div className="border-t border-border/40">
        <ThemeRow label="Accent">
          <ColorPill
            color={theme.accent}
            ariaLabel={`${titleLabel} accent color`}
            onChange={(next) => updateThemePack(variant, { accent: next })}
            onReset={
              theme.accent !== defaultTheme.accent
                ? () =>
                    updateThemePack(variant, {
                      accent: defaultTheme.accent,
                    })
                : undefined
            }
          />
        </ThemeRow>

        <ThemeRow label="Background">
          <ColorPill
            color={theme.surface}
            ariaLabel={`${titleLabel} background color`}
            onChange={(next) => updateThemePack(variant, { surface: next })}
            onReset={
              theme.surface !== defaultTheme.surface
                ? () =>
                    updateThemePack(variant, {
                      surface: defaultTheme.surface,
                    })
                : undefined
            }
          />
        </ThemeRow>

        <ThemeRow label="Foreground">
          <ColorPill
            color={theme.ink}
            ariaLabel={`${titleLabel} foreground color`}
            onChange={(next) => updateThemePack(variant, { ink: next })}
            onReset={
              theme.ink !== defaultTheme.ink
                ? () =>
                    updateThemePack(variant, {
                      ink: defaultTheme.ink,
                    })
                : undefined
            }
          />
        </ThemeRow>

        <ThemeRow label="UI font">
          <FontInput
            value={theme.fonts.ui ?? ""}
            placeholder="System default"
            ariaLabel={`${titleLabel} UI font`}
            onChange={(next) => updateThemeFonts(variant, { ui: next.length > 0 ? next : null })}
          />
        </ThemeRow>

        <ThemeRow label="Code font">
          <FontInput
            value={theme.fonts.code ?? ""}
            placeholder='"JetBrains Mono"'
            ariaLabel={`${titleLabel} code font`}
            mono
            onChange={(next) => updateThemeFonts(variant, { code: next.length > 0 ? next : null })}
          />
        </ThemeRow>

        <ThemeRow label="Translucent sidebar">
          <Switch
            checked={!theme.opaqueWindows}
            onCheckedChange={(checked) => updateThemePack(variant, { opaqueWindows: !checked })}
            aria-label={`${titleLabel} translucent sidebar`}
          />
        </ThemeRow>

        <ThemeRow label="Contrast">
          <ContrastSlider
            value={theme.contrast}
            onChange={(next) => updateThemePack(variant, { contrast: next })}
            ariaLabel={`${titleLabel} contrast`}
          />
        </ThemeRow>
      </div>
    </div>
  );
}

// ── Row primitive ─────────────────────────────────────────────────────────

function ThemeRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 border-t border-border/30 px-4 py-2 first:border-t-0">
      <span className="text-sm text-foreground/90">{label}</span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function ThemeSlotBadge({
  isActive,
  mode,
  variant,
}: {
  isActive: boolean;
  mode: ThemeMode;
  variant: ThemeVariant;
}) {
  const label = isActive ? "Active now" : mode === "system" ? "Standby" : "Inactive";
  const className = isActive
    ? "border-[color:var(--color-border-focus)]/35 bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]"
    : "border-[color:var(--color-border)] bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground-secondary)]";

  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-[10px] font-medium tracking-[0.02em]",
        className,
      )}
      title={isActive ? `${variant} is currently applied` : `${variant} slot preview`}
    >
      {label}
    </span>
  );
}

// ── Color pill ────────────────────────────────────────────────────────────

function ColorPill({
  color,
  ariaLabel,
  onChange,
  onReset,
}: {
  color: string;
  ariaLabel: string;
  onChange: (next: string) => void;
  onReset?: (() => void) | undefined;
}) {
  const colorInputRef = useRef<HTMLInputElement>(null);
  const [draftHex, setDraftHex] = useState<string | null>(null);
  const inputValue = draftHex ?? color;
  const textColor = useReadableTextColor(color);
  const ringColor = useReadableTextColor(color, 0.32);

  return (
    <div className="flex items-center gap-1">
      {onReset ? (
        <button
          type="button"
          onClick={onReset}
          className="rounded-sm p-1 text-[var(--color-text-foreground-tertiary)] transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-[var(--color-text-foreground)]"
          aria-label={`Reset ${ariaLabel}`}
          title="Reset to default"
        >
          <ResetGlyph />
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => colorInputRef.current?.click()}
        className="group relative flex h-8 min-w-44 items-center gap-2 overflow-hidden rounded-md px-2 pr-3 text-left transition-[transform,box-shadow] hover:scale-[1.005] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        style={{ backgroundColor: color, color: textColor }}
        aria-label={ariaLabel}
      >
        <span
          aria-hidden
          className="block size-5 shrink-0 rounded-full border"
          style={{ borderColor: ringColor }}
        />
        <input
          type="text"
          value={inputValue}
          onChange={(event) => {
            const next = event.target.value;
            setDraftHex(next);
            if (HEX_COLOR_RE.test(next.trim())) {
              onChange(next.trim().toLowerCase());
            }
          }}
          onBlur={() => {
            setDraftHex(null);
          }}
          onClick={(event) => event.stopPropagation()}
          spellCheck={false}
          maxLength={7}
          className="font-system-ui w-20 flex-1 bg-transparent text-[12px] uppercase tracking-tight outline-none placeholder:text-current/50"
          style={{ color: textColor }}
          aria-label={`${ariaLabel} hex value`}
        />
      </button>
      <input
        ref={colorInputRef}
        type="color"
        value={color}
        onChange={(event) => onChange(event.target.value.toLowerCase())}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
      />
    </div>
  );
}

function CodeThemeBadge({ theme }: { theme: ChromeTheme }) {
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-md border text-[10px] font-semibold leading-none"
      style={{
        backgroundColor: theme.surface,
        borderColor: mixColor(theme.surface, theme.ink, 0.16),
        color: theme.accent,
      }}
    >
      Aa
    </span>
  );
}

function CodeThemeSelectOption({ label, theme }: { label: string; theme: ChromeTheme }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <CodeThemeBadge theme={theme} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-[var(--color-text-foreground)]">{label}</div>
      </div>
    </div>
  );
}

// ── Font input ────────────────────────────────────────────────────────────

function FontInput({
  value,
  placeholder,
  ariaLabel,
  mono = false,
  onChange,
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  mono?: boolean;
  onChange: (next: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      value={draft ?? value}
      placeholder={placeholder}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        onChange(next);
      }}
      onBlur={() => setDraft(null)}
      spellCheck={false}
      aria-label={ariaLabel}
      className={cn("h-8 min-w-44 rounded-md px-3 text-right", mono && "font-chat-code")}
    />
  );
}

// ── Slider ────────────────────────────────────────────────────────────────

function ContrastSlider({
  value,
  onChange,
  ariaLabel,
}: {
  value: number;
  onChange: (next: number) => void;
  ariaLabel: string;
}) {
  const id = useId();
  const fillPct = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={ariaLabel}
        className="theme-slider h-1.5 w-44 cursor-pointer appearance-none rounded-full bg-transparent focus-visible:outline-none"
        style={{
          background: `linear-gradient(to right, var(--primary) 0%, var(--primary) ${fillPct}%, var(--input) ${fillPct}%, var(--input) 100%)`,
        }}
      />
      <span className="w-7 text-right font-chat-code text-xs text-muted-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}

// ── Import dialog ─────────────────────────────────────────────────────────

function ImportThemeDialog({
  variant,
  onImport,
}: {
  variant: ThemeVariant;
  onImport: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    try {
      onImport(value);
      toastManager.add({
        type: "success",
        title: "Theme imported",
        description: `Updated the ${variant} theme pack.`,
      });
      setValue("");
      setError(null);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to import that theme string.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs text-[var(--color-text-foreground-secondary)] transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-[var(--color-text-foreground)]"
          >
            Import
          </button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import {variant} theme</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Paste a{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-chat-code">codex-theme-v1:</code>{" "}
            share string. The embedded variant must match {variant}, and the selected code theme
            must exist for that variant.
          </p>
        </DialogHeader>
        <DialogPanel>
          <Textarea
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            placeholder='codex-theme-v1:{"codeThemeId":"linear",...}'
            spellCheck={false}
            rows={5}
            className="font-chat-code text-[11px]"
            aria-label="Theme share string"
          />
          {error ? <p className="mt-2 text-xs text-destructive-foreground">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" type="button">
                Cancel
              </Button>
            }
          />
          <Button type="button" disabled={value.trim().length === 0} onClick={handleSubmit}>
            Import
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function ResetGlyph() {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <polyline points="3 4 3 10 9 10" />
    </svg>
  );
}

function useReadableTextColor(hex: string, alpha = 1): string {
  const rgb = parseHex(hex);
  if (!rgb) {
    return alpha === 1 ? "#ffffff" : `rgba(255,255,255,${alpha})`;
  }
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  if (luminance > 0.6) {
    return alpha === 1 ? "#1a1c1f" : `rgba(26,28,31,${alpha})`;
  }
  return alpha === 1 ? "#ffffff" : `rgba(255,255,255,${alpha})`;
}

function mixColor(fromHex: string, toHex: string, amount: number): string {
  const from = parseHex(fromHex);
  const to = parseHex(toHex);
  if (!from || !to) return fromHex;
  const clamped = Math.max(0, Math.min(1, amount));
  const r = Math.round(from.r + (to.r - from.r) * clamped);
  const g = Math.round(from.g + (to.g - from.g) * clamped);
  const b = Math.round(from.b + (to.b - from.b) * clamped);
  return `rgb(${r}, ${g}, ${b})`;
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  if (!HEX_COLOR_RE.test(hex)) return null;
  const value = hex.slice(1);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}
