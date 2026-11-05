// FILE: IphoneMock.tsx
// Purpose: An iPhone showing Synara for iOS as it really looks: the Inbox (agent cards,
//          today's recap, projects, the floating composer) and the pairing scanner. Values
//          follow SynaraIOS (InboxView, InboxAgentCards, QRScannerView) at device points,
//          with sample data in place of a real account.
// Layer: Web UI illustration (aria-hidden; always dark, like the iOS app's screens here)

import type { ReactNode } from "react";

import { APP_BASE_NAME } from "~/branding";
import { ProviderIcon } from "~/components/ProviderIcon";
import { useTranslation } from "~/i18n";
import { Translation } from "~/i18n/Translation";
import {
  BellIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  FolderAddIcon,
  FolderIcon,
  KeyboardIcon,
  MicIcon,
  PageTextIcon,
  PlusIcon,
  SearchIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";

/** iPhone 17 Pro screen, in points. */
export const IPHONE_SCREEN_WIDTH = 402;
export const IPHONE_SCREEN_HEIGHT = 874;
const BEZEL = 12;
export const IPHONE_WIDTH = IPHONE_SCREEN_WIDTH + BEZEL * 2;
export const IPHONE_HEIGHT = IPHONE_SCREEN_HEIGHT + BEZEL * 2;

const IOS_BACKGROUND = "bg-[#121212]";
const IOS_CARD = "rounded-[20px] border border-white/8 bg-[#1c1c1c]";
const IOS_MUTED = "text-white/55";

export function IphoneMock(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative rounded-[64px] bg-[#0b0b0b] shadow-[0_0_0_1.5px_#3a3a3c,0_0_0_5px_#1d1d1f,0_40px_80px_-30px_rgb(0_0_0/0.6)]",
        props.className,
      )}
      style={{ width: IPHONE_WIDTH, height: IPHONE_HEIGHT, padding: BEZEL }}
    >
      <div
        className={cn(
          "relative size-full overflow-hidden rounded-[52px] font-sans text-white antialiased select-none",
          IOS_BACKGROUND,
        )}
      >
        {props.children}
        {/* Dynamic Island and home indicator sit above every screen. */}
        <span className="absolute top-[11px] left-1/2 h-[37px] w-[126px] -translate-x-1/2 rounded-full bg-black" />
        <span className="absolute bottom-[8px] left-1/2 h-[5px] w-[140px] -translate-x-1/2 rounded-full bg-white/70" />
      </div>
    </div>
  );
}

function StatusBar(props: { readonly time: string }) {
  return (
    <div className="flex h-[54px] items-center justify-between px-[34px] pt-[6px] text-[17px] font-semibold">
      <span className="w-[92px] text-center tabular-nums">{props.time}</span>
      <span className="flex items-center gap-[7px]">
        <svg width="19" height="12" viewBox="0 0 19 12" fill="white">
          <rect x="0" y="8" width="3.2" height="4" rx="1" />
          <rect x="5" y="5.5" width="3.2" height="6.5" rx="1" />
          <rect x="10" y="3" width="3.2" height="9" rx="1" />
          <rect x="15" y="0" width="3.2" height="12" rx="1" />
        </svg>
        <svg width="17" height="12" viewBox="0 0 17 12" fill="white">
          <path d="M8.5 2.6c2.4 0 4.6.9 6.2 2.5l1.2-1.2A10.4 10.4 0 0 0 8.5.9 10.4 10.4 0 0 0 1.1 3.9l1.2 1.2a8.7 8.7 0 0 1 6.2-2.5Zm0 3.4c1.5 0 2.8.6 3.8 1.5l1.2-1.2A7.1 7.1 0 0 0 8.5 4.3c-2 0-3.8.8-5 2.1l1.2 1.2c1-1 2.3-1.6 3.8-1.6Zm0 3.4c-.7 0-1.3.3-1.7.7L8.5 12l1.7-1.9c-.4-.4-1-.7-1.7-.7Z" />
        </svg>
        <span className="relative flex h-[13px] w-[27px] items-center rounded-[4px] border border-white/40 p-[1.5px]">
          <span className="h-full w-[78%] rounded-[2px] bg-white" />
          <span className="absolute -right-[3.5px] h-[4px] w-[1.5px] rounded-r-full bg-white/40" />
        </span>
      </span>
    </div>
  );
}

function useGreeting(date: Date): string {
  const { t, formatLocale } = useTranslation();
  const hour = date.getHours();
  const weekday = new Intl.DateTimeFormat(formatLocale, { weekday: "long" }).format(date);
  return t(
    hour < 12
      ? "onboarding:phoneGreetingMorning"
      : hour < 18
        ? "onboarding:phoneGreetingAfternoon"
        : "onboarding:phoneGreetingEvening",
    {
      // Starts a sentence, so capitalized in languages that write weekdays in lowercase.
      weekday: weekday.charAt(0).toLocaleUpperCase(formatLocale) + weekday.slice(1),
      date: new Intl.DateTimeFormat(formatLocale, { day: "numeric", month: "long" }).format(date),
    },
  );
}

function InboxCard(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly count?: number;
  readonly highlighted?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-[88px] flex-col justify-between p-[14px]",
        IOS_CARD,
        props.highlighted && "border-[#ff6b3d]/45 bg-[#2a1c17]",
      )}
    >
      <span className="flex h-[22px] items-center">{props.icon}</span>
      <span className="flex items-baseline gap-[6px] text-[17px]">
        <span>{props.title}</span>
        {props.count !== undefined ? (
          <span className={cn("tabular-nums", IOS_MUTED)}>{props.count}</span>
        ) : null}
      </span>
    </div>
  );
}

function InProgressIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <circle cx="11" cy="11" r="8.5" stroke="white" strokeOpacity="0.18" strokeWidth="2" />
      <path
        d="M11 2.5a8.5 8.5 0 0 0-8.5 8.5"
        stroke="white"
        strokeOpacity="0.85"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

const SAMPLE_AVATAR_INITIAL = "S";
const SAMPLE_RECAP_PROJECT = "synara-web";
const SAMPLE_RECAP_AGENT = "Claude Code";

const SAMPLE_PROJECTS = [
  { name: "synara-web", count: 5 },
  { name: "api-gateway", count: 2 },
  { name: "design-system", count: 1 },
] as const;

/** Synara for iOS: Inbox. `needsYou` lights the card an approval is waiting in. */
export function IosInboxScreen(props: {
  readonly host: string;
  readonly needsYou?: number;
  readonly banner?: ReactNode;
}) {
  const { t } = useTranslation();
  const greeting = useGreeting(new Date());
  const needsYou = props.needsYou ?? 0;
  return (
    <div className="relative flex size-full flex-col">
      <StatusBar time="9:41" />
      {props.banner ? (
        <div className="absolute inset-x-[10px] top-[56px] z-10">{props.banner}</div>
      ) : null}
      <div className="flex items-center justify-between px-[18px] pt-[6px]">
        <span className="flex size-[48px] items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_25%,#ffb347,#d9622b_55%,#3b2418)] text-[20px] font-semibold">
          {SAMPLE_AVATAR_INITIAL}
        </span>
        <span className="flex gap-[12px]">
          {[
            { id: "search", Icon: SearchIcon },
            { id: "new-project", Icon: FolderAddIcon },
          ].map(({ id, Icon }) => (
            <span
              key={id}
              className="flex size-[48px] items-center justify-center rounded-full border border-white/10 bg-[#262626]"
            >
              <Icon className="size-[22px]" />
            </span>
          ))}
        </span>
      </div>
      <div className="flex flex-col gap-[6px] px-[20px] pt-[18px] pb-[16px]">
        <span className="text-[34px] leading-[40px] font-bold tracking-[-0.01em]">
          {t("workspace:inbox")}
        </span>
        <span className={cn("text-[17px]", IOS_MUTED)}>{greeting}</span>
      </div>
      <div className="grid grid-cols-2 gap-[10px] px-[16px]">
        <InboxCard
          icon={<PageTextIcon className="size-[22px]" />}
          title={t("onboarding:phoneActivity")}
        />
        <InboxCard
          icon={<BellIcon className="size-[22px] text-[#ff6b3d]" />}
          title={t("onboarding:phoneNeedsYou")}
          count={needsYou}
          highlighted={needsYou > 0}
        />
        <InboxCard icon={<InProgressIcon />} title={t("onboarding:phoneInProgress")} count={3} />
        <InboxCard
          icon={<CircleCheckIcon className="size-[22px] text-[#30d158]" />}
          title={t("onboarding:phoneReadyForReview")}
          count={1}
        />
      </div>
      <div className="px-[20px] pt-[26px]">
        <div className="flex items-baseline justify-between">
          <span className={cn("text-[17px]", IOS_MUTED)}>
            {t("onboarding:phoneToday", { host: props.host })}
          </span>
          <span className={cn("text-[15px]", IOS_MUTED)}>{t("onboarding:phoneFullRecap")}</span>
        </div>
        <p className={cn("pt-[6px] text-[19px] leading-[28px]", IOS_MUTED)}>
          <Translation
            message="onboarding:phoneRecap"
            values={{ project: SAMPLE_RECAP_PROJECT, agent: SAMPLE_RECAP_AGENT }}
            components={{
              strong: <b className="font-medium text-white" />,
              folder: <FolderIcon className="mb-[3px] inline size-[18px] text-white" />,
              provider: (
                <ProviderIcon provider="claudeAgent" className="mb-[3px] inline size-[18px]" />
              ),
            }}
          />
        </p>
      </div>
      <div className="px-[20px] pt-[24px]">
        <span className={cn("text-[17px]", IOS_MUTED)}>
          {t("workspace:sections_projects")} <span className="ps-[4px] text-white/35">4</span>
        </span>
        <ul className="pt-[8px]">
          {SAMPLE_PROJECTS.map((project, index) => (
            <li key={project.name} className="flex items-center gap-[16px]">
              <FolderIcon className="size-[22px] shrink-0 text-white/60" />
              <span
                className={cn(
                  "flex min-w-0 flex-1 items-center py-[10px]",
                  index > 0 && "border-t border-white/10",
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[17px] leading-[22px]">{project.name}</span>
                  <span className={cn("text-[15px] leading-[20px]", IOS_MUTED)}>{props.host}</span>
                </span>
                <span className={cn("pe-[10px] text-[17px] tabular-nums", IOS_MUTED)}>
                  {project.count}
                </span>
                <ChevronRightIcon className="size-[18px] text-white/40" />
              </span>
            </li>
          ))}
        </ul>
      </div>
      {/* The floating composer, glass over the list. */}
      <div className="absolute inset-x-[14px] bottom-[28px] flex h-[56px] items-center gap-[10px] rounded-full border border-white/12 bg-[#262626]/85 px-[8px] shadow-[0_10px_30px_rgb(0_0_0/0.45)] backdrop-blur-xl">
        <span className="flex size-[42px] items-center justify-center rounded-full bg-white/8">
          <PlusIcon className="size-[22px] text-white/80" />
        </span>
        <span className="flex-1 text-[17px] text-white/50">
          {t("onboarding:phoneAskAnything", { app: APP_BASE_NAME })}
        </span>
        <span className="flex size-[42px] items-center justify-center rounded-full bg-white/10">
          <MicIcon className="size-[20px] text-white/80" />
        </span>
      </div>
    </div>
  );
}

/** An iOS notification banner from Synara, as it lands over the Inbox. */
export function IosNotificationBanner(props: { readonly title: string; readonly body: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-[12px] rounded-[26px] border border-white/10 bg-[#2c2c2e]/90 p-[14px] shadow-[0_18px_40px_rgb(0_0_0/0.5)] backdrop-blur-xl">
      <img src="/app-icons/dark.png" alt="" className="size-[40px] shrink-0" draggable={false} />
      <span className="flex min-w-0 flex-1 flex-col text-[15px] leading-[20px]">
        <span className="flex items-baseline justify-between">
          <span className="font-semibold">{props.title}</span>
          <span className="text-white/45">{t("chat:relativeTime_now")}</span>
        </span>
        <span className="text-white/85">{props.body}</span>
      </span>
    </div>
  );
}

/** Synara for iOS: the pairing scanner (QRScannerView) looking at this computer's code. */
export function IosScannerScreen(props: { readonly viewfinder: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="relative flex size-full flex-col bg-[radial-gradient(120%_70%_at_50%_45%,#1d1f24_0%,#0a0a0a_70%)]">
      <StatusBar time="9:41" />
      <div className="px-[20px] pt-[8px]">
        <span className="flex size-[44px] items-center justify-center rounded-full border border-white/18 bg-white/12">
          <ChevronLeftIcon className="size-[20px]" />
        </span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-[24px] pb-[40px]">
        <span className="relative flex size-[250px] items-center justify-center rounded-[20px] border-2 border-white/60">
          {props.viewfinder}
        </span>
        <span className="flex flex-col items-center gap-[6px] px-[32px] text-center">
          <span className="text-[17px] font-medium">{t("onboarding:phoneScanTitle")}</span>
          <span className="text-[15px] leading-[20px] text-white/70">
            {t("onboarding:phoneScanHint")}
          </span>
        </span>
      </div>
      <div className="flex justify-center pb-[44px]">
        <span className="flex h-[52px] items-center gap-[8px] rounded-full bg-white/14 px-[24px] text-[17px]">
          <KeyboardIcon className="size-[18px]" />
          {t("onboarding:phonePairWithCode")}
        </span>
      </div>
    </div>
  );
}
