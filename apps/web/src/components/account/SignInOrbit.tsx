// FILE: SignInOrbit.tsx
// Purpose: Hero of the sign-in dialog — the Synara app icon inside a slow orbit of the
//          agents Synara runs, on the dotted band the announcement dialogs use. The code
//          step swaps the travelling signal for a "code sent" badge on the icon.
//          The onboarding's ProviderRing is the full-stage version of this idea; its
//          560px layout, links and tiles do not fit a 196px dialog band.
// Layer: Web account feature (aria-hidden illustration)

import { ProviderIcon } from "~/components/ProviderIcon";
import { MailIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { VISIBLE_PROVIDER_DESCRIPTORS } from "../../betaFeatures";

/**
 * The sign-in accent: the design system's terracotta in light, its night accent in
 * dark. Set once on the dialog root; the orbit, focus ring, and links read it.
 */
export const SIGN_IN_ACCENT_CLASS_NAME =
  "[--sign-in-accent:#a43a0a] dark:[--sign-in-accent:#ffb27f]";

const WIDTH = 400;
const HEIGHT = 196;
const CENTER_X = WIDTH / 2;
const CENTER_Y = 102;
const INNER_RADIUS = 62;
const OUTER_RADIUS = 96;
const CHIP_SIZE = 30;
const CORE_SIZE = 84;

// Outer-orbit slots in degrees, alternating sides from the top down. The top and bottom
// of the circle stay empty so no agent is cut by the dialog edge or crowds the title.
const SLOT_ANGLES = [145, 35, 180, 0, 215, 325] as const;
// The lowest pair sits in the fade toward the title, so it is drawn quieter.
const QUIET_SLOT_COUNT = 2;

// The travelling signal: an arc along the inner orbit from 12 o'clock to 2 o'clock.
const SIGNAL_END_X = CENTER_X + INNER_RADIUS * Math.cos(Math.PI / 6);
const SIGNAL_END_Y = CENTER_Y - INNER_RADIUS * Math.sin(Math.PI / 6);

const BAND_BACKGROUND = [
  "linear-gradient(to bottom, transparent 50%, var(--color-popover))",
  "radial-gradient(circle at 50% 52%, color-mix(in srgb, var(--sign-in-accent) 18%, transparent), transparent 46%)",
  "radial-gradient(color-mix(in srgb, var(--color-foreground) 8%, transparent) 1px, transparent 1.3px)",
].join(", ");

export function SignInOrbit(props: { readonly mail?: boolean }) {
  const agents = VISIBLE_PROVIDER_DESCRIPTORS.slice(0, SLOT_ANGLES.length).map(
    (descriptor, index) => {
      const angle = ((SLOT_ANGLES[index] ?? 0) * Math.PI) / 180;
      return {
        kind: descriptor.kind,
        x: CENTER_X + OUTER_RADIUS * Math.cos(angle),
        y: CENTER_Y - OUTER_RADIUS * Math.sin(angle),
        quiet: index >= SLOT_ANGLES.length - QUIET_SLOT_COUNT,
      };
    },
  );

  return (
    <div
      aria-hidden
      className="relative shrink-0 overflow-hidden"
      style={{
        height: HEIGHT,
        backgroundImage: BAND_BACKGROUND,
        backgroundSize: "100% 100%, 100% 100%, 14px 14px",
      }}
    >
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2"
        style={{ width: WIDTH, height: HEIGHT }}
      >
        <svg
          width={WIDTH}
          height={HEIGHT}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="absolute inset-0 text-foreground"
        >
          <circle
            cx={CENTER_X}
            cy={CENTER_Y}
            r={INNER_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.1}
          />
          <circle
            cx={CENTER_X}
            cy={CENTER_Y}
            r={OUTER_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.12}
            strokeDasharray="2 5"
          />
          {props.mail ? null : (
            // One slow lap every 9s; reduced motion leaves it parked at 2 o'clock.
            <g
              className="motion-safe:animate-spin"
              style={{
                animationDuration: "9s",
                transformOrigin: `${CENTER_X}px ${CENTER_Y}px`,
              }}
            >
              <path
                d={`M${CENTER_X} ${CENTER_Y - INNER_RADIUS} A${INNER_RADIUS} ${INNER_RADIUS} 0 0 1 ${SIGNAL_END_X} ${SIGNAL_END_Y}`}
                fill="none"
                stroke="var(--sign-in-accent)"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
              <circle
                cx={SIGNAL_END_X}
                cy={SIGNAL_END_Y}
                r={8}
                fill="var(--sign-in-accent)"
                fillOpacity={0.18}
              />
              <circle cx={SIGNAL_END_X} cy={SIGNAL_END_Y} r={3} fill="var(--sign-in-accent)" />
            </g>
          )}
        </svg>

        {agents.map((agent) => (
          <span
            key={agent.kind}
            className={cn(
              "absolute flex items-center justify-center rounded-full border border-foreground/10 bg-popover",
              props.mail ? "opacity-35" : agent.quiet && "opacity-55",
            )}
            style={{
              left: agent.x - CHIP_SIZE / 2,
              top: agent.y - CHIP_SIZE / 2,
              width: CHIP_SIZE,
              height: CHIP_SIZE,
            }}
          >
            <ProviderIcon provider={agent.kind} className="size-[15px]" />
          </span>
        ))}

        <span
          className="absolute rounded-full"
          style={{
            left: CENTER_X - 50,
            top: CENTER_Y - 50,
            width: 100,
            height: 100,
            backgroundImage:
              "radial-gradient(circle, color-mix(in srgb, var(--sign-in-accent) 24%, transparent), transparent 70%)",
          }}
        />
        <img
          src="/app-icons/dark.png"
          alt=""
          draggable={false}
          className="absolute"
          style={{
            left: CENTER_X - CORE_SIZE / 2,
            top: CENTER_Y - CORE_SIZE / 2,
            width: CORE_SIZE,
            height: CORE_SIZE,
          }}
        />
        {props.mail ? (
          <span
            className="absolute flex size-7 items-center justify-center rounded-full bg-[var(--sign-in-accent)] text-white ring-[3px] ring-popover dark:text-black/80"
            style={{ left: CENTER_X + 24, top: CENTER_Y - 46 }}
          >
            <MailIcon className="size-3.5" />
          </span>
        ) : null}
      </div>
    </div>
  );
}
