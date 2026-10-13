import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, setLanguagePreference } from "~/i18n";

import { AUTH_SIGNED_OUT_PATH, bootstrapSignedOutScreen } from "./authSignedOut";

afterEach(() => {
  vi.unstubAllGlobals();
  setLanguagePreference("system");
});

describe("bootstrapSignedOutScreen", () => {
  it("renders the stored Spanish language and document title before React without adding listeners", () => {
    i18n.addResourceBundle("es", "translation", {
      "Signed out · Synara": "Sesión cerrada · Synara",
      "Session closed": "Sesión cerrada",
      "This browser no longer controls Synara.": "Este navegador ya no controla Synara.",
    });
    setLanguagePreference("en");
    const root = { innerHTML: "", querySelector: () => ({ focus: vi.fn() }) };
    const doc = { title: "", documentElement: { lang: "en" }, getElementById: () => root };
    const addEventListener = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => '{"language":"es"}' });
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", { location: { pathname: AUTH_SIGNED_OUT_PATH }, addEventListener });

    expect(bootstrapSignedOutScreen()).toBe(true);
    expect(doc.documentElement.lang).toBe("es");
    expect(doc.title).toBe("Sesión cerrada · Synara");
    expect(root.innerHTML).toContain("Sesión cerrada");
    expect(root.innerHTML).toContain("Este navegador ya no controla Synara.");
    expect(root.innerHTML).toContain('id="signed-out-title"');
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("renders only on the dedicated signed-out route", () => {
    const render = vi.fn();

    expect(bootstrapSignedOutScreen({ pathname: "/", render })).toBe(false);
    expect(render).not.toHaveBeenCalled();

    expect(bootstrapSignedOutScreen({ pathname: AUTH_SIGNED_OUT_PATH, render })).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
