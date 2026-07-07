// FILE: SoccerBall.tsx
// Purpose: From-scratch SVG soccer ball asset (central + ringed pentagons, seams, shading).
// Layer: World Cup 2026 view
// Exports: SoccerBall

import { useTranslation } from "react-i18next";

const CENTER = 50;
const RIM_RADIUS = 47;
const CENTER_PENTAGON_RADIUS = 14;
const OUTER_PENTAGON_RADIUS = 11;
const OUTER_PENTAGON_DISTANCE = 32;

function pentagonPoints(cx: number, cy: number, radius: number, startAngleDeg: number): string {
  const points: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const angle = ((startAngleDeg + i * 72) * Math.PI) / 180;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return points.join(" ");
}

// The truncated-icosahedron flat projection: one pentagon dead center, five more
// arranged around it, each pointing back toward the center. Seams radiate out from
// the central pentagon's vertices to the rim so the spin reads clearly when rotating.
const CENTER_PENTAGON = pentagonPoints(CENTER, CENTER, CENTER_PENTAGON_RADIUS, -90);

const OUTER_PENTAGONS = Array.from({ length: 5 }, (_, index) => {
  const centerAngleDeg = -54 + index * 72;
  const rad = (centerAngleDeg * Math.PI) / 180;
  const cx = CENTER + OUTER_PENTAGON_DISTANCE * Math.cos(rad);
  const cy = CENTER + OUTER_PENTAGON_DISTANCE * Math.sin(rad);
  return pentagonPoints(cx, cy, OUTER_PENTAGON_RADIUS, centerAngleDeg + 180 - 90);
});

const SEAMS = Array.from({ length: 5 }, (_, index) => {
  const angleDeg = -90 + index * 72;
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x1: CENTER + CENTER_PENTAGON_RADIUS * Math.cos(rad),
    y1: CENTER + CENTER_PENTAGON_RADIUS * Math.sin(rad),
    x2: CENTER + RIM_RADIUS * Math.cos(rad),
    y2: CENTER + RIM_RADIUS * Math.sin(rad),
  };
});

export interface SoccerBallProps {
  className?: string;
}

export function SoccerBall({ className }: SoccerBallProps) {
  const { t } = useTranslation();
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      role="img"
      aria-label={t("accessibility.soccerBall")}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <radialGradient id="ball-sphere" cx="38%" cy="32%" r="72%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="62%" stopColor="#f2f3f5" />
          <stop offset="100%" stopColor="#c9ccd2" />
        </radialGradient>
        <radialGradient id="ball-shine" cx="34%" cy="28%" r="34%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.9)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>

      <circle cx={CENTER} cy={CENTER} r={RIM_RADIUS} fill="url(#ball-sphere)" />

      <g stroke="#0f1115" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round">
        {SEAMS.map((seam, index) => (
          <line key={`seam-${index}`} x1={seam.x1} y1={seam.y1} x2={seam.x2} y2={seam.y2} />
        ))}
      </g>

      <g fill="#15171c" stroke="#0a0b0e" strokeWidth={1} strokeLinejoin="round">
        <polygon points={CENTER_PENTAGON} />
        {OUTER_PENTAGONS.map((points, index) => (
          <polygon key={`pentagon-${index}`} points={points} />
        ))}
      </g>

      {/* Specular highlight + crisp rim sit on top so the panels still read as 3D. */}
      <circle cx={CENTER} cy={CENTER} r={RIM_RADIUS} fill="url(#ball-shine)" />
      <circle
        cx={CENTER}
        cy={CENTER}
        r={RIM_RADIUS}
        fill="none"
        stroke="rgba(15,17,21,0.55)"
        strokeWidth={1.5}
      />
    </svg>
  );
}
