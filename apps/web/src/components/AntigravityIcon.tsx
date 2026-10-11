// FILE: AntigravityIcon.tsx
// Purpose: Renders the official compact Antigravity mark used across provider surfaces.
// Layer: Shared web UI icon

import { useId, type SVGProps } from "react";

export function AntigravityBrandIcon(props: SVGProps<SVGSVGElement>) {
  const prefix = useId();
  const maskId = `${prefix}-antigravity-mask`;
  const filterIds = Array.from(
    { length: 11 },
    (_, index) => `${prefix}-antigravity-filter-${index}`,
  );

  return (
    <svg
      {...props}
      width="16"
      height="15"
      viewBox="0 0 16 15"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <mask
        id={maskId}
        style={{ maskType: "alpha" }}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="16"
        height="15"
      >
        <path
          d="M14.08 13.98C14.95 14.63 16.25 14.2 15.05 13.01C11.48 9.54 12.23 0 7.79 0C3.35 0 4.1 9.54 0.53 13.01C-0.77 14.31 0.64 14.63 1.5 13.98C4.86 11.71 4.65 7.7 7.79 7.7C10.93 7.7 10.72 11.71 14.08 13.98Z"
          fill="black"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <g filter={`url(#${filterIds[0]})`}>
          <path
            d="M-0.66 -3.23C-0.92 -0.91 1.08 1.23 3.81 1.54C6.55 1.85 8.98 0.22 9.24 -2.11C9.51 -4.43 7.5 -6.57 4.77 -6.88C2.04 -7.19 -0.4 -5.55 -0.66 -3.23Z"
            fill="#FFE432"
          />
        </g>
        <g filter={`url(#${filterIds[1]})`}>
          <path
            d="M9.88 4.37C10.57 7.32 13.57 9.14 16.58 8.44C19.59 7.74 21.48 4.78 20.8 1.83C20.11 -1.12 17.11 -2.94 14.1 -2.24C11.09 -1.54 9.2 1.42 9.88 4.37Z"
            fill="#FC413D"
          />
        </g>
        <g filter={`url(#${filterIds[2]})`}>
          <path
            d="M-8.05 6.35C-7.19 9.39 -3.29 10.95 0.65 9.83C4.6 8.7 7.09 5.33 6.23 2.28C5.36 -0.76 1.46 -2.32 -2.48 -1.2C-6.42 -0.08 -8.92 3.3 -8.05 6.35Z"
            fill="#00B95C"
          />
        </g>
        <g filter={`url(#${filterIds[3]})`}>
          <path
            d="M-8.05 6.35C-7.19 9.39 -3.29 10.95 0.65 9.83C4.6 8.7 7.09 5.33 6.23 2.28C5.36 -0.76 1.46 -2.32 -2.48 -1.2C-6.42 -0.08 -8.92 3.3 -8.05 6.35Z"
            fill="#00B95C"
          />
        </g>
        <g filter={`url(#${filterIds[4]})`}>
          <path
            d="M-4.92 8.87C-2.75 11.08 0.98 10.94 3.42 8.56C5.86 6.17 6.08 2.43 3.91 0.22C1.74 -2 -2 -1.86 -4.44 0.53C-6.87 2.92 -7.09 6.65 -4.92 8.87Z"
            fill="#00B95C"
          />
        </g>
        <g filter={`url(#${filterIds[5]})`}>
          <path
            d="M6.43 17.23C7.1 20.13 9.91 21.95 12.71 21.3C15.5 20.66 17.22 17.78 16.54 14.88C15.87 11.98 13.06 10.15 10.27 10.8C7.47 11.45 5.75 14.33 6.43 17.23Z"
            fill="#3186FF"
          />
        </g>
        <g filter={`url(#${filterIds[6]})`}>
          <path
            d="M1.67 -5.95C0.25 -2.8 1.8 0.95 5.11 2.44C8.43 3.93 12.26 2.59 13.67 -0.56C15.08 -3.7 13.54 -7.45 10.22 -8.94C6.91 -10.43 3.08 -9.09 1.67 -5.95Z"
            fill="#FBBC04"
          />
        </g>
        <g filter={`url(#${filterIds[7]})`}>
          <path
            d="M-2.11 24.39C-5.53 23.05 0.31 12.02 1.76 8.32C3.21 4.62 7.16 2.71 10.57 4.05C13.99 5.39 18.04 12.78 16.58 16.48C15.13 20.17 1.3 25.73 -2.11 24.39Z"
            fill="#3186FF"
          />
        </g>
        <g filter={`url(#${filterIds[8]})`}>
          <path
            d="M18.58 10.66C17.67 11.73 15.28 11.18 13.25 9.44C11.22 7.71 10.32 5.43 11.23 4.36C12.15 3.3 14.53 3.84 16.56 5.58C18.59 7.32 19.5 9.59 18.58 10.66Z"
            fill="#749BFF"
          />
        </g>
        <g filter={`url(#${filterIds[9]})`}>
          <path
            d="M11.76 5.23C15.52 7.77 19.85 7.94 21.43 5.6C23.01 3.26 21.24 -0.7 17.48 -3.24C13.72 -5.78 9.39 -5.95 7.81 -3.61C6.23 -1.27 7.99 2.68 11.76 5.23Z"
            fill="#FC413D"
          />
        </g>
        <g filter={`url(#${filterIds[10]})`}>
          <path
            d="M-0.59 1.09C-1.52 3.34 -1.22 5.6 0.09 6.14C1.39 6.68 3.21 5.3 4.14 3.05C5.07 0.8 4.77 -1.46 3.46 -2C2.15 -2.54 0.34 -1.16 -0.59 1.09Z"
            fill="#FFEE48"
          />
        </g>
      </g>
      <defs>
        {[
          [-2.13, -8.36, 12.84, 11.38, 0.72],
          [2.75, -9.38, 25.18, 24.96, 3.5],
          [-14.17, -7.5, 26.51, 23.63, 2.97],
          [-14.17, -7.5, 26.51, 23.63, 2.97],
          [-12.36, -7.3, 23.71, 23.68, 2.97],
          [0.63, 5.02, 21.7, 22.06, 2.82],
          [-3.98, -14.67, 23.29, 22.83, 2.56],
          [-7.74, -0.95, 29.2, 30.11, 2.29],
          [6.79, -0.27, 16.24, 15.57, 2.04],
          [3.78, -8.72, 21.69, 19.42, 1.73],
          [-5.41, -6.39, 14.36, 16.93, 2.14],
        ].map(([x, y, width, height, deviation], index) => (
          <filter
            key={filterIds[index]}
            id={filterIds[index]}
            x={x}
            y={y}
            width={width}
            height={height}
            filterUnits="userSpaceOnUse"
            colorInterpolationFilters="sRGB"
          >
            <feFlood floodOpacity="0" result="BackgroundImageFix" />
            <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
            <feGaussianBlur stdDeviation={deviation} result={`effect1_foregroundBlur_${index}`} />
          </filter>
        ))}
      </defs>
    </svg>
  );
}
