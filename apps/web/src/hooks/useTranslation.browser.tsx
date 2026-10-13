import { useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { AppSettingsSchema } from "~/appSettings";
import { APP_SETTINGS_STORAGE_KEY } from "~/appSettingsStorage";
import { getFormatLocale, initializeI18n, setLanguagePreference, useTranslation } from "~/i18n";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { formatShortDate } from "~/components/profile/profileFormatting";
import { formatVisualNumber } from "~/components/chat/inlineVisualBlocks.logic";
import { workEntryDisplayParts } from "~/components/chat/TimelineWorkEntryRow";
import type { WorkLogEntry } from "~/session-logic";

let previousSettings: string | null;

beforeEach(() => {
  previousSettings = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, '{"language":"en"}');
  setLanguagePreference("en");
});

afterEach(() => {
  if (previousSettings === null) localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
  else localStorage.setItem(APP_SETTINGS_STORAGE_KEY, previousSettings);
  setLanguagePreference("system");
});

describe("reactive interface language", () => {
  it("updates an unchanged command row while preserving its literal command", async () => {
    const entry: WorkLogEntry = {
      id: "command-language-test",
      createdAt: "2026-10-13T10:00:00Z",
      tone: "tool",
      label: "Command completed",
      itemType: "command_execution",
      toolStatus: "completed",
      command: "echo Settings",
    };
    const hook = await renderHook(() => {
      const { t } = useTranslation();
      return workEntryDisplayParts(entry, t);
    });
    try {
      expect(hook.result.current.heading).toBe("Ran");
      expect(hook.result.current.commandLiteral).toBe("echo Settings");
      setLanguagePreference("es");
      await vi.waitFor(() => expect(hook.result.current.heading).toBe("Ejecutó"));
      expect(hook.result.current.commandLiteral).toBe("echo Settings");
      setLanguagePreference("en");
      await vi.waitFor(() => expect(hook.result.current.heading).toBe("Ran"));
    } finally {
      await hook.unmount();
    }
  });

  it("reformats unchanged dates and numbers in mounted compiler-enabled consumers", async () => {
    const hook = await renderHook(() => {
      const { formatLocale } = useTranslation();
      return {
        number: formatVisualNumber(12345.67, {}, formatLocale),
        date: formatShortDate("2026-04-03", formatLocale),
      };
    });
    try {
      expect(hook.result.current.number).toBe("12,345.67");
      setLanguagePreference("es");
      await vi.waitFor(() => expect(hook.result.current.number).toBe("12.345,67"));
      expect(hook.result.current.date).toBe(
        new Intl.DateTimeFormat("es", { month: "short", day: "numeric", timeZone: "UTC" }).format(
          new Date("2026-04-03T00:00:00Z"),
        ),
      );
      setLanguagePreference("system");
      await vi.waitFor(() =>
        expect(hook.result.current.number).toBe(
          new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(12345.67),
        ),
      );
    } finally {
      await hook.unmount();
    }
  });

  it("refreshes memoized formatting when System changes to the same explicit language", async () => {
    setLanguagePreference("system");
    const hook = await renderHook(() => {
      const { t, locale, formatLocale: resolvedFormatLocale } = useTranslation();
      const formatLocale = useMemo(() => getFormatLocale(), [t]);
      return { t, locale, formatLocale, resolvedFormatLocale };
    });
    try {
      const originalTranslator = hook.result.current.t;
      expect(hook.result.current.formatLocale).toBeUndefined();
      expect(hook.result.current.resolvedFormatLocale).toBe(
        new Intl.NumberFormat().resolvedOptions().locale,
      );
      setLanguagePreference(hook.result.current.locale === "es" ? "es" : "en");
      await vi.waitFor(() =>
        expect(hook.result.current.formatLocale).toBe(hook.result.current.locale),
      );
      expect(hook.result.current.t).not.toBe(originalTranslator);
      expect(hook.result.current.resolvedFormatLocale).toBe(hook.result.current.locale);
    } finally {
      await hook.unmount();
    }
  });

  it("updates memoized copy without remounting or losing the draft and keeps installed translators current", async () => {
    let mounts = 0;
    const hook = await renderHook(() => {
      const { t, locale } = useTranslation();
      const [draft, setDraft] = useState(() => {
        mounts += 1;
        return "unsent draft";
      });
      const label = useMemo(() => t("Settings"), [t]);
      return { t, locale, label, draft, setDraft };
    });
    try {
      const installedTranslator = hook.result.current.t;
      flushSync(() => hook.result.current.setDraft("my edited draft"));
      setLanguagePreference("es");
      await vi.waitFor(() => expect(hook.result.current.label).toBe("Ajustes"));
      expect(hook.result.current.locale).toBe("es");
      expect(hook.result.current.t).not.toBe(installedTranslator);
      expect(installedTranslator("Settings")).toBe("Ajustes");
      expect(hook.result.current.draft).toBe("my edited draft");
      expect(mounts).toBe(1);
    } finally {
      await hook.unmount();
    }
  });

  it("uses the existing persisted settings notification and restores the chosen language on bootstrap", async () => {
    let dispose = initializeI18n();
    const hook = await renderHook(() => {
      const [settings, setSettings] = useLocalStorage(
        APP_SETTINGS_STORAGE_KEY,
        AppSettingsSchema.makeUnsafe({}),
        AppSettingsSchema,
      );
      const { t } = useTranslation();
      return { settings, setSettings, label: t("Settings") };
    });
    try {
      flushSync(() =>
        hook.result.current.setSettings((previous) => ({ ...previous, language: "es" })),
      );
      await vi.waitFor(() => expect(hook.result.current.label).toBe("Ajustes"));
      expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!).language).toBe("es");
      expect(document.documentElement.lang).toBe("es");
      dispose();
      setLanguagePreference("en");
      dispose = initializeI18n();
      await vi.waitFor(() => expect(hook.result.current.label).toBe("Ajustes"));
    } finally {
      dispose();
      await hook.unmount();
    }
  });
});
