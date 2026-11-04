// FILE: ProviderRing.tsx
// Purpose: The onboarding hero illustration: every visible provider on a ring around the
//          Synara app icon. Agents detected as connected on this machine get a live (blue,
//          pulsing) link; the rest stay dashed until they are set up.
// Layer: Web UI illustration (aria-hidden)

import type { ProviderKind } from "@synara/contracts";

import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";
import { VISIBLE_PROVIDER_DESCRIPTORS } from "../../betaFeatures";
import { ONBOARDING_LIVE_COLOR } from "./stageTokens";

const CANVAS = 560;
const CENTER = CANVAS / 2;
const RING_RADIUS = 190;
const TILE_SIZE = 72;
const CORE_SIZE = 168;

export const PROVIDER_RING_SIZE = CANVAS;

export function ProviderRing(props: { readonly live: ReadonlySet<ProviderKind> }) {
  const count = VISIBLE_PROVIDER_DESCRIPTORS.length;
  const nodes = VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor, index) => {
    const angle = ((-90 + (index * 360) / count) * Math.PI) / 180;
    return {
      kind: descriptor.kind,
      x: CENTER + RING_RADIUS * Math.cos(angle),
      y: CENTER + RING_RADIUS * Math.sin(angle),
      live: props.live.has(descriptor.kind),
    };
  });

  return (
    <div aria-hidden className="relative" style={{ width: CANVAS, height: CANVAS }}>
      <svg
        width={CANVAS}
        height={CANVAS}
        viewBox={`0 0 ${CANVAS} ${CANVAS}`}
        className="absolute inset-0 overflow-visible text-foreground"
      >
        {[118, RING_RADIUS, 250].map((radius) => (
          <circle
            key={radius}
            cx={CENTER}
            cy={CENTER}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.12}
          />
        ))}
        {nodes.map((node) =>
          node.live ? (
            <line
              key={node.kind}
              x1={CENTER}
              y1={CENTER}
              x2={node.x}
              y2={node.y}
              stroke={ONBOARDING_LIVE_COLOR}
              strokeWidth={1.5}
            />
          ) : (
            <line
              key={node.kind}
              x1={CENTER}
              y1={CENTER}
              x2={node.x}
              y2={node.y}
              stroke="currentColor"
              strokeOpacity={0.32}
              strokeDasharray="2 5"
            />
          ),
        )}
        {nodes
          .filter((node) => node.live)
          .map((node) => {
            // A beacon a little past halfway along the link, clear of the core icon.
            const bx = CENTER + (node.x - CENTER) * 0.55;
            const by = CENTER + (node.y - CENTER) * 0.55;
            return (
              <g key={node.kind}>
                <circle cx={bx} cy={by} r={8} className="fill-background" />
                <circle
                  cx={bx}
                  cy={by}
                  r={4}
                  fill={ONBOARDING_LIVE_COLOR}
                  className="motion-safe:animate-pulse"
                />
              </g>
            );
          })}
      </svg>

      {nodes.map((node) => (
        <div
          key={node.kind}
          className="absolute"
          style={{
            left: node.x - TILE_SIZE / 2,
            top: node.y - TILE_SIZE / 2,
            width: TILE_SIZE,
            height: TILE_SIZE,
          }}
        >
          {node.live ? (
            <span
              className="absolute -inset-4 rounded-full border motion-safe:animate-pulse"
              style={{ borderColor: `${ONBOARDING_LIVE_COLOR}66` }}
            />
          ) : null}
          <span
            className={cn(
              "relative flex size-full items-center justify-center rounded-[18px] bg-popover",
              "shadow-[0_1px_2px_rgb(0_0_0/0.06),0_16px_32px_-14px_rgb(0_0_0/0.35)] dark:border dark:border-foreground/10",
            )}
          >
            <ProviderIcon provider={node.kind} className="size-9" />
          </span>
        </div>
      ))}

      <img
        src="/app-icons/dark.png"
        alt=""
        draggable={false}
        className="absolute"
        style={{
          left: CENTER - CORE_SIZE / 2,
          top: CENTER - CORE_SIZE / 2,
          width: CORE_SIZE,
          height: CORE_SIZE,
        }}
      />
    </div>
  );
}
