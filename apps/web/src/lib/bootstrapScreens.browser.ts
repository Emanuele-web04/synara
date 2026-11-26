import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_SIGNED_OUT_PATH, bootstrapSignedOutScreen } from "../authSignedOut";
import { bootstrapPairingSession } from "../pairingBootstrap";
import { i18n } from "../i18n";

let root: HTMLDivElement;
let previousUrl: string;
let previousHistoryState: unknown;
let previousTitle: string;

beforeEach(() => {
  previousUrl = location.href;
  previousHistoryState = history.state;
  previousTitle = document.title;
  root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  root.remove();
  history.replaceState(previousHistoryState, "", previousUrl);
  document.title = previousTitle;
});

const screens = [
  {
    name: "signed-out",
    path: AUTH_SIGNED_OUT_PATH,
    title: "Signed out · Synara",
    heading: "This browser no longer controls Synara.",
    messageKey: "sessionClosed",
    async bootstrap() {
      expect(bootstrapSignedOutScreen()).toBe(true);
    },
  },
  {
    name: "pairing failure",
    path: "/pair#token=PAIRING-SECRET",
    title: "Pairing failed · Synara",
    heading: "This pairing link could not be used.",
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
  describe(`${screen.name} screen before React`, () => {
    it("renders its copy, title, and focus without exposing credentials", async () => {
      history.replaceState(null, "", screen.path);
      const addEventListener = vi.spyOn(window, "addEventListener");
      await screen.bootstrap();
      expect(document.title).toBe(screen.title);
      expect(root.querySelector("h1")?.textContent).toBe(screen.heading);
      expect(document.activeElement).toBe(root.querySelector("h1"));
      expect(root.textContent).not.toContain("PAIRING-SECRET");
      expect(addEventListener).not.toHaveBeenCalled();
    });

    it("preserves hostile catalog markup as text instead of inserting HTML", async () => {
      history.replaceState(null, "", screen.path);
      const original: string = i18n.getResource("en", "common", screen.messageKey);
      const hostile = `<img src="x" onerror="this.dataset.executed='yes'">中文 & <script>document.title='injected'</script>`;
      i18n.addResource("en", "common", screen.messageKey, hostile);
      try {
        await screen.bootstrap();
        expect(root.textContent).toContain(hostile);
        expect(root.querySelector("img, script")).toBeNull();
        expect(root.innerHTML).toContain("&lt;img");
      } finally {
        i18n.addResource("en", "common", screen.messageKey, original);
      }
    });
  });
}
