// FILE: authSignedOut.ts
// Purpose: Replaces authenticated application state after the current browser session logs out.
import { setLanguagePreference, t } from "~/i18n";
import { readLanguagePreference } from "~/i18n/locale";

export const AUTH_SIGNED_OUT_PATH = "/signed-out";

function renderSignedOutScreen(): void {
  setLanguagePreference(readLanguagePreference());
  const root = document.getElementById("root");
  if (!root) return;

  document.title = t("common:signedOutSynara");
  root.innerHTML = `
    <main aria-labelledby="signed-out-title" style="min-height:100vh;box-sizing:border-box;display:grid;place-items:center;padding:32px;background:#10110f;color:#f3f0e8;font-family:'DM Sans',sans-serif">
      <section style="position:relative;width:min(100%,560px);overflow:hidden;border:1px solid #373a34;background:#171915;padding:clamp(30px,6vw,56px);box-shadow:12px 12px 0 #080907">
        <div aria-hidden="true" style="position:absolute;inset:0 0 auto auto;width:128px;height:8px;background:#d6ff55"></div>
        <p style="margin:0 0 22px;color:#d6ff55;font:600 12px/1.2 'JetBrains Mono',monospace;letter-spacing:.16em;text-transform:uppercase"></p>
        <h1 id="signed-out-title" tabindex="-1" style="max-width:470px;margin:0;color:#fffdf7;font-size:clamp(36px,7vw,58px);font-weight:600;line-height:.96;letter-spacing:-.05em"></h1>
        <p style="max-width:440px;margin:26px 0 0;color:#b8bbb2;font-size:16px;line-height:1.65"></p>
      </section>
    </main>`;
  root.querySelectorAll("section > p, section > h1")[0]!.textContent = t("common:sessionClosed");
  root.querySelectorAll("section > p, section > h1")[1]!.textContent = t(
    "common:thisBrowserNoLongerControlsSynara",
  );
  root.querySelectorAll("section > p, section > h1")[2]!.textContent = t(
    "common:theSessionAndItsLiveConnectionsWereRevokedTo",
  );
  root.querySelector<HTMLElement>("h1")?.focus();
}

export function bootstrapSignedOutScreen(
  input: {
    readonly pathname: string;
    readonly render: () => void;
  } = {
    pathname: window.location.pathname,
    render: renderSignedOutScreen,
  },
): boolean {
  if (input.pathname !== AUTH_SIGNED_OUT_PATH) return false;
  input.render();
  return true;
}
