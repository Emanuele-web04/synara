// FILE: AccountStep.tsx
// Purpose: Optional sign-in stage of the onboarding: the real sign-in flow (SSO and email
//          code) in a card, between what the account is for and what stays local.
// Layer: Web UI component

import type { AccountStatus } from "@synara/contracts";

import { SignInPanel } from "~/components/account/SignInDialog";
import { useTranslation } from "~/i18n";
import { CheckIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ONBOARDING_STAGE_CARD_CLASS_NAME } from "../stage/stageTokens";

function SideNote(props: {
  readonly title: string;
  readonly items: readonly string[];
  readonly inverted?: boolean;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "mt-16 hidden w-[260px] shrink-0 flex-col gap-2.5 p-5 lg:flex",
        props.inverted
          ? "rounded-[14px] bg-foreground text-background shadow-[0_24px_48px_-20px_rgb(0_0_0/0.45)]"
          : ONBOARDING_STAGE_CARD_CLASS_NAME,
      )}
    >
      <span
        className={cn(
          "text-ui-xs tracking-[0.1em] uppercase",
          props.inverted ? "text-background/55" : "text-muted-foreground",
        )}
      >
        {props.title}
      </span>
      {props.items.map((item) => (
        <span key={item} className="flex items-center gap-2 text-ui">
          {props.inverted ? <CheckIcon className="size-3.5 shrink-0" /> : null}
          {item}
        </span>
      ))}
    </div>
  );
}

export function AccountStep(props: {
  readonly onMac: boolean;
  readonly onSignedIn: (status: AccountStatus) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-full items-start justify-center gap-10 px-8 pt-14 pb-10">
      <SideNote
        title={t("onboarding:accountNoteTitle")}
        items={[
          t(props.onMac ? "onboarding:accountNoteLinksMac" : "onboarding:accountNoteLinksComputer"),
          t("onboarding:accountNoteProfile"),
        ]}
      />
      <div className={cn("w-[420px] max-w-full shrink-0 p-6", ONBOARDING_STAGE_CARD_CLASS_NAME)}>
        <SignInPanel variant="embedded" onSignedIn={props.onSignedIn} />
      </div>
      <SideNote
        inverted
        title={t(
          props.onMac ? "onboarding:localNoteTitleMac" : "onboarding:localNoteTitleComputer",
        )}
        items={[
          t("onboarding:localNoteAgents"),
          t("onboarding:localNoteRepositories"),
          t("onboarding:localNoteCommands"),
        ]}
      />
    </div>
  );
}
