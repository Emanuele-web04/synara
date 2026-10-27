import { afterEach, beforeEach, expect, it, vi } from "vitest";

type NlsGlobals = {
  _VSCODE_NLS_MESSAGES?: string[];
  _VSCODE_NLS_LANGUAGE?: string;
};
const globals = globalThis as NlsGlobals;
const originalMessages = globals._VSCODE_NLS_MESSAGES;
const originalLanguage = globals._VSCODE_NLS_LANGUAGE;

beforeEach(() => {
  vi.resetModules();
  delete globals._VSCODE_NLS_MESSAGES;
  delete globals._VSCODE_NLS_LANGUAGE;
  // Observe the package's NLS ABI at the editor graph's evaluation boundary,
  // without loading DOM/CSS-dependent editor widgets into a unit test.
  vi.doMock("./MonacoEditorSurface", () => ({
    // Monaco 0.57's Find action registers localize2(1002, "Find") on import.
    default: globals._VSCODE_NLS_MESSAGES?.[1002] ?? "Find",
  }));
});

afterEach(() => {
  vi.doUnmock("./MonacoEditorSurface");
  if (originalMessages) globals._VSCODE_NLS_MESSAGES = originalMessages;
  else delete globals._VSCODE_NLS_MESSAGES;
  if (originalLanguage) globals._VSCODE_NLS_LANGUAGE = originalLanguage;
  else delete globals._VSCODE_NLS_LANGUAGE;
});

it.each([
  ["en", "Find"],
  ["zh-CN", "查找"],
  ["es", "Buscar"],
])("loads %s NLS before the lazy editor graph evaluates", async (language, expected) => {
  const { i18n } = await import("~/i18n");
  await i18n.changeLanguage(language);
  const { loadLocalizedEditorSurface, getLoadedEditorLanguage } =
    await import("./editorLocalization");
  expect(getLoadedEditorLanguage()).toBeNull();
  expect(globals._VSCODE_NLS_MESSAGES).toBeUndefined();

  const surface = await loadLocalizedEditorSurface();

  expect(surface.default).toBe(expected);
  expect(getLoadedEditorLanguage()).toBe(language);
});

it("retains one engine language while the interface changes until the document reloads", async () => {
  const { i18n } = await import("~/i18n");
  await i18n.changeLanguage("zh-CN");
  const { loadLocalizedEditorSurface, getLoadedEditorLanguage } =
    await import("./editorLocalization");
  await loadLocalizedEditorSurface();
  const messages = globals._VSCODE_NLS_MESSAGES;

  await i18n.changeLanguage("es");
  await loadLocalizedEditorSurface();

  expect(i18n.language).toBe("es");
  expect(getLoadedEditorLanguage()).toBe("zh-CN");
  expect(globals._VSCODE_NLS_MESSAGES).toBe(messages);
  expect(globals._VSCODE_NLS_LANGUAGE).toBe("zh-cn");
});
