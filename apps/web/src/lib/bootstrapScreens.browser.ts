import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_SETTINGS_STORAGE_KEY } from "../appSettingsStorage";
import { AUTH_SIGNED_OUT_PATH, bootstrapSignedOutScreen } from "../authSignedOut";
import { bootstrapPairingSession } from "../pairingBootstrap";
import { i18n, setLanguagePreference } from "../i18n";

let root: HTMLDivElement;
let previousSettings: string | null;
let previousUrl: string;
let previousHistoryState: unknown;
let previousTitle: string;
let previousLanguage: string;
let previousDirection: string;

beforeEach(() => {
  previousSettings = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  previousUrl = location.href;
  previousHistoryState = history.state;
  previousTitle = document.title;
  previousLanguage = document.documentElement.lang;
  previousDirection = document.documentElement.dir;
  root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, '{"language":"zh-CN"}');
  setLanguagePreference("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  root.remove();
  history.replaceState(previousHistoryState, "", previousUrl);
  if (previousSettings === null) localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
  else localStorage.setItem(APP_SETTINGS_STORAGE_KEY, previousSettings);
  setLanguagePreference("system");
  document.title = previousTitle;
  document.documentElement.lang = previousLanguage;
  document.documentElement.dir = previousDirection;
});

const screens = [
  {
    name: "signed-out",
    path: AUTH_SIGNED_OUT_PATH,
    title: "已退出登录 · Synara",
    heading: "此浏览器已无法控制 Synara。",
    messageKey: "sessionClosed",
    async bootstrap() {
      expect(bootstrapSignedOutScreen()).toBe(true);
    },
  },
  {
    name: "pairing failure",
    path: "/pair#token=PAIRING-SECRET",
    title: "配对失败 · Synara",
    heading: "无法使用此配对链接。",
    messageKey: "securePairingInterrupted",
    async bootstrap() {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 401 })),
      );
      await expect(bootstrapPairingSession()).resolves.toBe("failed");
      expect(location.hash).toBe("");
    },
  },
] as const;

for (const screen of screens) {
  describe(`${screen.name} localization before React`, () => {
    it("renders the saved Chinese preference, document metadata, and focus without exposing credentials", async () => {
      history.replaceState(null, "", screen.path);
      const addEventListener = vi.spyOn(window, "addEventListener");
      await screen.bootstrap();
      expect(document.title).toBe(screen.title);
      expect(document.documentElement.lang).toBe("zh-CN");
      expect(document.documentElement.dir).toBe("ltr");
      expect(root.querySelector("h1")?.textContent).toBe(screen.heading);
      expect(document.activeElement).toBe(root.querySelector("h1"));
      expect(root.textContent).not.toContain("PAIRING-SECRET");
      expect(addEventListener).not.toHaveBeenCalled();
    });

    it("still renders using System when access to the storage object itself throws", async () => {
      history.replaceState(null, "", screen.path);
      vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-Hans-CN"]);
      vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
        throw new DOMException("Storage denied", "SecurityError");
      });
      await screen.bootstrap();
      expect(root.querySelector("h1")?.textContent).toBe(screen.heading);
      expect(document.documentElement.lang).toBe("zh-CN");
    });

    it("preserves hostile catalog markup as text instead of inserting HTML", async () => {
      history.replaceState(null, "", screen.path);
      const original: string = i18n.getResource("zh-CN", "common", screen.messageKey);
      const hostile = `<img src="x" onerror="this.dataset.executed='yes'">中文 & <script>document.title='injected'</script>`;
      i18n.addResource("zh-CN", "common", screen.messageKey, hostile);
      try {
        await screen.bootstrap();
        expect(root.textContent).toContain(hostile);
        expect(root.querySelector("img, script")).toBeNull();
        expect(root.innerHTML).toContain("&lt;img");
      } finally {
        i18n.addResource("zh-CN", "common", screen.messageKey, original);
      }
    });
  });
}
