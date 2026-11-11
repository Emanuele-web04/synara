// FILE: ProviderRing.tsx
// Purpose: The onboarding hero illustration: every visible provider on a ring around the
//          Synara app icon. Agents detected as connected on this machine get a live (blue)
//          link with a halo; the rest stay dashed until they are set up.
// Layer: Web UI illustration (aria-hidden)
//
// Motion (index.css `scene-*`): the core and tiles rise in, links draw out from the core,
// then the tiles drift, the outer guide turns, and a packet keeps travelling out along
// every link. Reduced motion shows the settled frame with no packets or halos.

import type { ProviderKind } from "@synara/contracts";
import type { CSSProperties } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";
import { VISIBLE_PROVIDER_DESCRIPTORS } from "../../betaFeatures";
import { ONBOARDING_LIVE_COLOR } from "./stageTokens";

const CANVAS = 560;
const CENTER = CANVAS / 2;
const RING_RADIUS = 190;
const TILE_SIZE = 72;
const CORE_SIZE = 168;
/** Packets run between the core's edge and the tile's edge. */
const PACKET_START_RADIUS = CORE_SIZE / 2 + 4;
const PACKET_END_RADIUS = RING_RADIUS - TILE_SIZE / 2 - 6;
/** The core lands first; tiles follow one after another, then the links draw. */
const TILE_DELAY_MS = 220;
const TILE_STAGGER_MS = 70;

export const PROVIDER_RING_SIZE = CANVAS;

export function ProviderRing(props: { readonly live: ReadonlySet<ProviderKind> }) {
  const count = VISIBLE_PROVIDER_DESCRIPTORS.length;
  const nodes = VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor, index) => {
    const angle = ((-90 + (index * 360) / count) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      kind: descriptor.kind,
      index,
      cos,
      sin,
      x: CENTER + RING_RADIUS * cos,
      y: CENTER + RING_RADIUS * sin,
      live: props.live.has(descriptor.kind),
      delayMs: TILE_DELAY_MS + index * TILE_STAGGER_MS,
    };
  });
  const linksDelayMs = TILE_DELAY_MS + count * TILE_STAGGER_MS;

  return (
    <div aria-hidden className="relative" style={{ width: CANVAS, height: CANVAS }}>
      <svg
        width={CANVAS}
        height={CANVAS}
        viewBox={`0 0 ${CANVAS} ${CANVAS}`}
        className="absolute inset-0 overflow-visible text-foreground"
      >
        <g className="scene-fade-in">
          {[118, RING_RADIUS].map((radius) => (
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
          {/* The outer guide is dashed so its slow turn reads. */}
          <circle
            cx={CENTER}
            cy={CENTER}
            r={250}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.16}
            strokeDasharray="2 7"
            className="scene-spin-slow"
            style={{ transformOrigin: `${CENTER}px ${CENTER}px` }}
          />
        </g>
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
              pathLength={1}
              className="scene-draw"
              style={{ animationDelay: `${linksDelayMs + node.index * 40}ms` }}
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
              className="scene-fade-in"
              style={{ animationDelay: `${linksDelayMs + node.index * 40}ms` }}
            />
          ),
        )}
        {nodes.map((node) => (
          <circle
            key={node.kind}
            cx={CENTER + PACKET_START_RADIUS * node.cos}
            cy={CENTER + PACKET_START_RADIUS * node.sin}
            r={node.live ? 3.5 : 2.5}
            fill={node.live ? ONBOARDING_LIVE_COLOR : "currentColor"}
            fillOpacity={node.live ? 1 : 0.4}
            className="scene-packet"
            style={
              {
                // Offset the packets so they leave the core one after another.
                animationDelay: `${linksDelayMs + 600 + node.index * 380}ms`,
                animationDuration: node.live ? "2.4s" : "3.2s",
                "--scene-travel-x": `${(PACKET_END_RADIUS - PACKET_START_RADIUS) * node.cos}px`,
                "--scene-travel-y": `${(PACKET_END_RADIUS - PACKET_START_RADIUS) * node.sin}px`,
              } as CSSProperties
            }
          />
        ))}
      </svg>

      {nodes.map((node) => (
        <div
          key={node.kind}
          className="scene-rise absolute"
          style={{
            left: node.x - TILE_SIZE / 2,
            top: node.y - TILE_SIZE / 2,
            width: TILE_SIZE,
            height: TILE_SIZE,
            animationDelay: `${node.delayMs}ms`,
          }}
        >
          {/* Drift lives on an inner layer so it never fights the entrance transform. */}
          <div
            className="scene-float relative size-full"
            style={{
              animationDuration: `${5 + (node.index % 3)}s`,
              animationDelay: `${-node.index * 1.3}s`,
            }}
          >
            {node.live ? (
              <span
                className="scene-halo absolute -inset-4 rounded-full border"
                style={{
                  borderColor: `${ONBOARDING_LIVE_COLOR}80`,
                  animationDelay: `${node.index * 0.35}s`,
                }}
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
        </div>
      ))}

      <img
        src="/app-icons/dark.png"
        alt=""
        draggable={false}
        className="scene-rise absolute"
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
