// FILE: ReadyStep.tsx
// Purpose: Last onboarding screen: a receipt of what was set up, the provider ring lit for
//          every connected agent, and the first project (browse, drop anywhere, or a typed
//          path in the browser build). Adding a project finishes the tour.
// Layer: Web UI component

import type { ProviderKind } from "@synara/contracts";
import { useState, type FormEvent } from "react";

import { APP_BASE_NAME } from "~/branding";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { isElectron } from "~/env";
import { useTranslation } from "~/i18n";
import { CheckIcon, FolderIcon, MinusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { OnboardingScreen } from "../OnboardingScreen";
import { FitStage } from "../stage/FitStage";
import { PROVIDER_RING_SIZE, ProviderRing } from "../stage/ProviderRing";
import { ONBOARDING_STAGE_CARD_CLASS_NAME } from "../stage/stageTokens";
import { type OnboardingProjectResult, useProjectAdder } from "../useProjectAdder";

export interface OnboardingReceiptRow {
  readonly label: string;
  readonly value: string;
  readonly done: boolean;
}

function Receipt(props: { readonly rows: readonly OnboardingReceiptRow[] }) {
  const { t } = useTranslation();
  return (
    <dl
      className={cn(
        "w-[320px] max-w-full divide-y divide-foreground/8",
        ONBOARDING_STAGE_CARD_CLASS_NAME,
      )}
    >
      {props.rows.map((row) => (
        <div key={row.label} className="flex h-10 items-center gap-3 px-4 text-ui">
          {row.done ? (
            <CheckIcon
              className="size-3.5 shrink-0 text-success"
              aria-label={t("onboarding:receiptDone")}
            />
          ) : (
            <MinusIcon
              className="size-3.5 shrink-0 text-muted-foreground/60"
              aria-label={t("onboarding:receiptSkipped")}
            />
          )}
          <dt className="flex-1 text-foreground">{row.label}</dt>
          <dd className="truncate text-muted-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ReadyStep(props: {
  readonly receipt: readonly OnboardingReceiptRow[];
  readonly live: ReadonlySet<ProviderKind>;
  readonly onProjectAdded: (result: OnboardingProjectResult) => void;
  readonly onExplore: () => void;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const adder = useProjectAdder({
    onResult: props.onProjectAdded,
    onBusyChange: props.onBusyChange,
  });
  const [path, setPath] = useState("");
  const { t } = useTranslation();

  const submitPath = (event: FormEvent) => {
    event.preventDefault();
    void adder.addProject(path);
  };

  return (
    <OnboardingScreen
      lead={t("onboarding:readyLead")}
      statement={t("onboarding:readyStatement")}
      description={t(
        isElectron ? "onboarding:readyDescriptionDesktop" : "onboarding:readyDescriptionWeb",
        { app: APP_BASE_NAME },
      )}
      actionsPlacement="inline"
      primary={
        isElectron
          ? {
              label: t(
                adder.picking ? "onboarding:readyChoosingFolder" : "onboarding:readyOpenProject",
              ),
              onClick: () => void adder.browse(),
              busy: adder.busy,
            }
          : undefined
      }
      secondary={{
        label: t("onboarding:readyExploreFirst"),
        onClick: props.onExplore,
        disabled: adder.busy,
      }}
      aside={<Receipt rows={props.receipt} />}
      footnote={
        <>
          {isElectron ? null : (
            <form onSubmit={submitPath} className="flex max-w-[520px] items-center gap-2">
              <InputGroup className="h-10 min-w-0 flex-1 rounded-full sm:h-9">
                <InputGroupAddon>
                  <FolderIcon className="size-4 text-muted-foreground/70" aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  value={path}
                  onChange={(event) => {
                    setPath(event.target.value);
                    adder.clearError();
                  }}
                  placeholder={
                    adder.homeDir
                      ? t("onboarding:codeMyRepo", { value0: adder.homeDir })
                      : t("onboarding:pathToRepository")
                  }
                  aria-label={t("workspace:projectFolderPath")}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  disabled={adder.submitting}
                />
              </InputGroup>
              <Button
                type="submit"
                shape="capsule"
                size="lg"
                className="px-4"
                disabled={adder.submitting || path.trim().length === 0}
              >
                {t("workspace:sections_addProject")}
              </Button>
            </form>
          )}
          {adder.error ? (
            <p role="alert" className="text-ui text-destructive">
              {adder.error}
            </p>
          ) : null}
        </>
      }
      stageClassName={cn(
        "overflow-hidden transition-colors motion-reduce:transition-none",
        adder.isDropTarget &&
          "bg-[#317CFF]/6 outline-2 -outline-offset-8 outline-[#317CFF]/50 outline-dashed",
      )}
    >
      <FitStage width={PROVIDER_RING_SIZE + 80} height={PROVIDER_RING_SIZE + 40}>
        <div className="flex size-full items-center justify-center">
          <ProviderRing live={props.live} />
        </div>
      </FitStage>
    </OnboardingScreen>
  );
}
