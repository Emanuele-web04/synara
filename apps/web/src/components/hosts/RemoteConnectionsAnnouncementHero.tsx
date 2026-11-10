// FILE: RemoteConnectionsAnnouncementHero.tsx
// Purpose: Hero art for the Remote Connections launch sheet: a laptop and a desktop
//          running Synara, linked over an abstract orange backdrop.
// Layer: Web hosts UI
// Exports: RemoteConnectionsAnnouncementHero
//
// Everything is drawn in code, no bitmap: the backdrop is blurred SVG waves with a light
// grain, and the two screens use theme tokens so they turn dark with the app. The link
// dots pulse toward the desktop and the link node breathes; both stop under reduced motion.

import { useId, type CSSProperties, type ReactNode } from "react";

import { LinkIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

const DEVICE_SHADOW_CLASS_NAME = "drop-shadow-[0_18px_22px_rgba(110,35,0,0.35)]";
const BEZEL_CLASS_NAME = "flex bg-neutral-900 p-[5px] ring-1 ring-white/15 ring-inset";
const ALUMINIUM_CLASS_NAME = "bg-linear-to-b from-neutral-200 to-neutral-400";
const CLAUDE_TILE_CLASS_NAME = "bg-[#d97757]";
const ACCENT_CLASS_NAME = "bg-orange-600";

// Staggered so the four dots light up in a wave from the laptop toward the desktop.
const FLOW_DELAYS_MS = [0, 180, 540, 720] as const;

export function RemoteConnectionsAnnouncementHero() {
  return (
    <div className="absolute inset-0 select-none">
      <Backdrop />
      <div className="absolute inset-0 flex items-end justify-center gap-[22px] pb-[42px]">
        <Laptop />
        <Link />
        <Desktop />
      </div>
    </div>
  );
}

/** Warm orange field with soft, out-of-focus waves; scales to cover the band. */
function Backdrop() {
  // SVG ids are document-global, so each instance namespaces its own.
  const id = useId().replace(/[^\w-]/g, "");
  const ref = (name: string) => `url(#${id}-${name})`;
  return (
    <svg
      className="absolute inset-0 size-full"
      viewBox="0 0 480 268"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id={`${id}-field`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb98a" />
          <stop offset="0.45" stopColor="#ff7a2e" />
          <stop offset="1" stopColor="#c2410c" />
        </linearGradient>
        <linearGradient id={`${id}-wave`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ff9a52" />
          <stop offset="1" stopColor="#e25505" />
        </linearGradient>
        <filter id={`${id}-soft`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="16" />
        </filter>
        <filter id={`${id}-grain`}>
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="2"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>
      <rect width="480" height="268" fill={ref("field")} />
      <g filter={ref("soft")}>
        <ellipse cx="120" cy="34" rx="220" ry="64" fill="#ffe6d2" opacity="0.7" />
        <path
          d="M-40 150 C 80 92, 200 214, 320 142 S 520 92, 560 132 V 320 H -40 Z"
          fill={ref("wave")}
          opacity="0.9"
        />
        <path
          d="M-20 118 C 120 58, 262 170, 500 88"
          fill="none"
          stroke="#fff3ea"
          strokeWidth="26"
          strokeLinecap="round"
          opacity="0.45"
        />
        <path
          d="M-40 214 C 100 168, 230 256, 370 206 S 520 176, 560 196 V 320 H -40 Z"
          fill="#b83a06"
          opacity="0.55"
        />
      </g>
      <rect
        width="480"
        height="268"
        filter={ref("grain")}
        opacity="0.07"
        style={{ mixBlendMode: "overlay" }}
      />
    </svg>
  );
}

function Laptop() {
  return (
    <div className={cn("flex flex-col items-center", DEVICE_SHADOW_CLASS_NAME)}>
      <div className={cn("h-24 w-[150px] rounded-t-[10px] rounded-b-[3px]", BEZEL_CLASS_NAME)}>
        <MiniWindow>
          <div className="flex flex-1 flex-col justify-between">
            <AgentLines />
            <div className="flex h-[15px] items-center justify-end rounded-[5px] px-[3px] ring-1 ring-orange-600 shadow-[0_0_0_3px_rgba(234,88,12,0.16)]">
              <span className="size-[9px] rounded-[3px] bg-foreground" />
            </div>
          </div>
        </MiniWindow>
      </div>
      <div
        className={cn("flex h-[7px] w-[174px] justify-center rounded-b-lg", ALUMINIUM_CLASS_NAME)}
      >
        <span className="h-[3px] w-8 rounded-b-[3px] bg-neutral-400" />
      </div>
    </div>
  );
}

function Desktop() {
  return (
    <div className={cn("flex flex-col items-center", DEVICE_SHADOW_CLASS_NAME)}>
      <div className={cn("h-[100px] w-[152px] rounded-[10px]", BEZEL_CLASS_NAME)}>
        <MiniWindow>
          <div className="flex flex-1 flex-col gap-1">
            <AgentLines />
            <span className="flex h-3 w-11 items-center gap-[3px] rounded-[4px] bg-muted px-1">
              <span className="h-0.5 w-5 rounded-full bg-foreground/25" />
              <span className="h-0.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            <span className="flex h-[11px] items-center gap-[3px] self-start rounded-full bg-emerald-500/15 px-[5px]">
              <span className="size-1 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
              <span className="h-0.5 w-[18px] rounded-full bg-emerald-600/60" />
            </span>
          </div>
        </MiniWindow>
      </div>
      <div className="h-[22px] w-7 bg-linear-to-r from-neutral-400 via-neutral-200 to-neutral-400" />
      <div className={cn("h-[5px] w-16 rounded-t-[3px] rounded-b-[2px]", ALUMINIUM_CLASS_NAME)} />
    </div>
  );
}

function Link() {
  return (
    <div className="flex items-center gap-[5px] pb-[50px]">
      <FlowDot delayMs={FLOW_DELAYS_MS[0]} />
      <FlowDot delayMs={FLOW_DELAYS_MS[1]} />
      <span className="relative flex size-[30px] items-center justify-center rounded-full bg-white text-orange-600 shadow-[0_0_0_5px_rgba(255,255,255,0.28),0_8px_20px_-6px_rgba(110,35,0,0.5)]">
        <span className="absolute inset-0 rounded-full bg-white/50 motion-safe:animate-ping motion-safe:[animation-duration:2.4s]" />
        <LinkIcon className="relative size-3.5" />
      </span>
      <FlowDot delayMs={FLOW_DELAYS_MS[2]} />
      <FlowDot delayMs={FLOW_DELAYS_MS[3]} />
    </div>
  );
}

function FlowDot({ delayMs }: { delayMs: number }) {
  const style: CSSProperties = { animationDelay: `${delayMs}ms` };
  return (
    <span className="size-1 rounded-full bg-white/80 motion-safe:animate-pulse" style={style} />
  );
}

/** A Synara window in miniature: traffic lights, a sidebar, and the chat area. */
function MiniWindow({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-[5px] bg-background">
      <div className="flex h-3 shrink-0 items-center gap-[3px] px-1.5">
        <span className="size-1 rounded-full bg-[#ff5f57]" />
        <span className="size-1 rounded-full bg-[#febc2e]" />
        <span className="size-1 rounded-full bg-[#28c840]" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[34px] shrink-0 flex-col gap-1 bg-muted px-[5px] py-1">
          <span className="h-[3px] rounded-full bg-foreground/15" />
          <span className={cn("h-[3px] w-[22px] rounded-full opacity-60", ACCENT_CLASS_NAME)} />
          <span className="h-[3px] w-[18px] rounded-full bg-foreground/10" />
        </div>
        <div className="flex min-w-0 flex-1 px-[7px] pt-[5px] pb-1.5">{children}</div>
      </div>
    </div>
  );
}

function AgentLines() {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <span className={cn("size-[7px] rounded-[2px]", CLAUDE_TILE_CLASS_NAME)} />
        <span className="h-[3px] w-[58px] rounded-full bg-foreground/15" />
      </div>
      <span className="h-[3px] w-[90%] rounded-full bg-foreground/8" />
      <span className="h-[3px] w-[70%] rounded-full bg-foreground/8" />
    </div>
  );
}
