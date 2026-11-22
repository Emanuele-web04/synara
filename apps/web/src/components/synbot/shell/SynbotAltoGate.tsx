// FILE: SynbotAltoGate.tsx
// Purpose: What SynBot shows while the host requires Synara Alto (Pro): SynBot's face, the
//          title with its Beta badge, what it does, and the way in (Sign in while the account is
//          known to be signed out; View Alto plans). Shared by the SynBot page and Settings →
//          SynBot. Sign in waits until the account's state is known, so a signed-in user never
//          sees it flash.
// Layer: SynBot UI
// Exports: SynbotAltoGate

import { BOT_MASCOT_COLORS } from "@synara/contracts";

import { useAccount } from "~/hooks/useAccount";
import { useTranslation } from "~/i18n";

import { useAccountDialogStore } from "../../account/accountDialogStore";
import { useOpenSynaraPlan } from "../../settings/BillingSettingsPanel";
import { Badge } from "../../ui/badge";
import { CapsuleButton } from "../kit/controls";
import { BotMascot } from "../kit/Mascot";
import "../kit/holobot.css";
import "./shell.css";

export function SynbotAltoGate() {
  const { t } = useTranslation();
  const { status: accountStatus } = useAccount();
  const openPlans = useOpenSynaraPlan();
  // Null while the account's state is still being read: neither signed in nor out yet.
  const signedOut = accountStatus?.state === "signed-out";
  const signedIn = accountStatus?.state === "signed-in";
  return (
    <div className="hb synbot-shell__alto">
      <BotMascot shape="synara" color={BOT_MASCOT_COLORS[0]} size={48} mood="idle" />
      <div className="synbot-shell__alto-title">
        <h2 className="text-ui-lg font-medium text-foreground">{t("synbot:altoTitle")}</h2>
        <Badge variant="secondary" size="sm">
          {t("synbot:betaBadge")}
        </Badge>
      </div>
      <p className="synbot-shell__alto-body">{t("synbot:altoDescription")}</p>
      <div className="synbot-shell__alto-actions">
        {signedOut ? (
          <CapsuleButton
            kind="primary"
            onClick={() => useAccountDialogStore.getState().openSignIn()}
          >
            {t("synbot:altoSignIn")}
          </CapsuleButton>
        ) : null}
        <CapsuleButton kind={signedIn ? "primary" : "normal"} onClick={openPlans}>
          {t("synbot:altoViewPlans")}
        </CapsuleButton>
      </div>
    </div>
  );
}
