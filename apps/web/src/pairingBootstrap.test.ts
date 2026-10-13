import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, setLanguagePreference } from "~/i18n";

import { bootstrapPairingSession } from "./pairingBootstrap";

afterEach(() => {
  vi.unstubAllGlobals();
  setLanguagePreference("system");
});

function makeDependencies(input: {
  readonly pathname?: string;
  readonly hash?: string;
  readonly responseOk?: boolean;
}) {
  const events: Array<string> = [];
  const replace = vi.fn((url: string) => events.push(`navigate:${url}`));
  const replaceState = vi.fn((_data: unknown, _unused: string, url?: string | URL | null) =>
    events.push(`scrub:${String(url)}`),
  );
  const fetch = vi.fn(async () => {
    events.push("fetch");
    return { ok: input.responseOk ?? true } as Response;
  });
  const renderFailure = vi.fn(() => events.push("failure"));

  return {
    dependencies: {
      location: {
        pathname: input.pathname ?? "/pair",
        search: "",
        hash: input.hash ?? "#token=PAIRING-SECRET",
        replace,
      },
      history: { replaceState },
      fetch: fetch as typeof globalThis.fetch,
      renderFailure,
    },
    events,
    fetch,
    replace,
    replaceState,
    renderFailure,
  };
}

describe("bootstrapPairingSession", () => {
  it("renders Spanish failure copy and document language without exposing the pairing credential", async () => {
    i18n.addResourceBundle("es", "translation", {
      "Pairing failed · Synara": "Error de vinculación · Synara",
      "Secure pairing interrupted": "Vinculación segura interrumpida",
      "This pairing link could not be used.": "No se pudo utilizar este enlace de vinculación.",
    });
    setLanguagePreference("en");
    const root = { innerHTML: "", querySelector: () => ({ focus: vi.fn() }) };
    const doc = { title: "", documentElement: { lang: "en" }, getElementById: () => root };
    const addEventListener = vi.fn();
    const replaceState = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => '{"language":"es"}' });
    vi.stubGlobal("document", doc);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    vi.stubGlobal("window", {
      location: { pathname: "/pair", search: "", hash: "#token=PAIRING-SECRET", replace: vi.fn() },
      history: { replaceState },
      addEventListener,
    });

    await expect(bootstrapPairingSession()).resolves.toBe("failed");
    expect(doc.documentElement.lang).toBe("es");
    expect(doc.title).toBe("Error de vinculación · Synara");
    expect(root.innerHTML).toContain("Vinculación segura interrumpida");
    expect(root.innerHTML).toContain("No se pudo utilizar este enlace de vinculación.");
    expect(root.innerHTML).not.toContain("PAIRING-SECRET");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/pair");
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("ignores every route except the dedicated pairing route", async () => {
    const test = makeDependencies({ pathname: "/" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("not-pairing");
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.replaceState).not.toHaveBeenCalled();
  });

  it("scrubs the fragment before exchanging it and redirects after success", async () => {
    const test = makeDependencies({});

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("redirecting");

    expect(test.events).toEqual(["scrub:/pair", "fetch", "navigate:/"]);
    expect(test.fetch).toHaveBeenCalledWith("/api/auth/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "PAIRING-SECRET" }),
    });
  });

  it("renders a token-free failure state when the exchange is rejected", async () => {
    const test = makeDependencies({ responseOk: false });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("failed");

    expect(test.events).toEqual(["scrub:/pair", "fetch", "failure"]);
    expect(test.replace).not.toHaveBeenCalled();
    expect(test.renderFailure).toHaveBeenCalledOnce();
  });

  it("fails without making a request when the fragment has no credential", async () => {
    const test = makeDependencies({ hash: "" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("failed");
    expect(test.events).toEqual(["scrub:/pair", "failure"]);
    expect(test.fetch).not.toHaveBeenCalled();
  });
});
