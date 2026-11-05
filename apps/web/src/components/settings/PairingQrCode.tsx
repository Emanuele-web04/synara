// FILE: PairingQrCode.tsx
// Purpose: The pairing link as a QR code drawn with round modules, rounded finder
//          squares and the Synara mark in its centre.
// Layer: Settings UI components
// Exports: PairingQrCode

import { SynaraLogo } from "@synara/profile-ui/logo";
import { useMemo } from "react";
import { encode, QrCodeDataType } from "uqr";

// Dark modules on a light tile whatever the theme: phone scanners are not
// guaranteed to read an inverted code.
const INK = "#111111";
// Each dark module is a zero-length stroke with round caps: a dot this wide.
const DOT_DIAMETER = 0.84;
const FINDER_SIZE = 7;

/**
 * Medium error correction keeps the link at a readable module size and still
 * recovers the few modules the centre mark covers.
 */
function pairingQrGeometry(value: string) {
  const qr = encode(value, { ecc: "M", border: 0 });
  const size = qr.size;
  // An odd span keeps the cleared square centred on a module.
  const logoSpan = Math.round(size * 0.2) | 1;
  const logoStart = (size - logoSpan) / 2;
  const insideLogo = (x: number, y: number) =>
    x >= logoStart && x < logoStart + logoSpan && y >= logoStart && y < logoStart + logoSpan;
  let dots = "";
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!qr.data[y]?.[x] || qr.types[y]?.[x] === QrCodeDataType.Position || insideLogo(x, y))
        continue;
      dots += `M${x + 0.5} ${y + 0.5}h0`;
    }
  }
  const far = size - FINDER_SIZE;
  return {
    size,
    dots,
    logoSpan,
    finders: [
      [0, 0],
      [far, 0],
      [0, far],
    ] as const,
  };
}

export function PairingQrCode({
  value,
  label,
  pixelSize = 196,
}: {
  value: string;
  label: string;
  pixelSize?: number;
}) {
  const qr = useMemo(() => pairingQrGeometry(value), [value]);
  // The mark sits inside the cleared square with a module of breathing room.
  const logoPixels = ((qr.logoSpan - 1.5) / qr.size) * pixelSize;
  return (
    <div
      role="img"
      aria-label={label}
      className="relative rounded-[22px] bg-white p-3.5 ring-1 ring-black/8"
    >
      <svg
        aria-hidden
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        width={pixelSize}
        height={pixelSize}
        className="block"
      >
        <path
          d={qr.dots}
          fill="none"
          stroke={INK}
          strokeWidth={DOT_DIAMETER}
          strokeLinecap="round"
        />
        {qr.finders.map(([x, y]) => (
          <g key={`${x}:${y}`}>
            <rect
              x={x + 0.5}
              y={y + 0.5}
              width={FINDER_SIZE - 1}
              height={FINDER_SIZE - 1}
              rx={1.9}
              fill="none"
              stroke={INK}
              strokeWidth={1}
            />
            <rect x={x + 2} y={y + 2} width={3} height={3} rx={0.9} fill={INK} />
          </g>
        ))}
      </svg>
      <span
        aria-hidden
        className="absolute inset-0 m-auto flex items-center justify-center rounded-[28%] text-white"
        style={{ width: logoPixels, height: logoPixels, backgroundColor: INK }}
      >
        <SynaraLogo className="w-1/2 text-white" />
      </span>
    </div>
  );
}
