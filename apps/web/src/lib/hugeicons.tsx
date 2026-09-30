// FILE: hugeicons.tsx
// Purpose: The few Hugeicons the app uses (stroke · rounded), inlined as SVG so the icon
//          package is not a dependency. Paths copied verbatim from
//          @hugeicons/core-free-icons 4.3.5 (MIT, https://hugeicons.com).
// Layer: Icon registry (re-exported from ~/lib/icons)

import type { SVGProps } from "react";

import type { LucideIcon } from "./icons";

interface HugeiconPath {
  d: string;
  // Hugeicons leaves the cap off lines that meet the frame, so they stop flush with it.
  round?: boolean;
}

function createHugeicon(displayName: string, paths: readonly HugeiconPath[]): LucideIcon {
  function Hugeicon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={24}
        height={24}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden
        {...props}
      >
        {paths.map((path) => (
          <path
            key={path.d}
            d={path.d}
            {...(path.round ? { strokeLinecap: "round", strokeLinejoin: "round" } : {})}
          />
        ))}
      </svg>
    );
  }
  Hugeicon.displayName = displayName;
  return Hugeicon;
}

const ROUNDED_SQUARE =
  "M11 3H13C16.7712 3 18.6569 3 19.8284 4.17157C21 5.34315 21 7.22876 21 11V13C21 16.7712 21 18.6569 19.8284 19.8284C18.6569 21 16.7712 21 13 21H11C7.22876 21 5.34315 21 4.17157 19.8284C3 18.6569 3 16.7712 3 13V11C3 7.22876 3 5.34315 4.17157 4.17157C5.34315 3 7.22876 3 11 3Z";

/** Sidebar on the left, collapsed (`layout-align-right`). */
export const LayoutAlignRightIcon = createHugeicon("LayoutAlignRightIcon", [
  { d: ROUNDED_SQUARE, round: true },
  { d: "M16 8L16 16", round: true },
]);

/** Sidebar on the left, open (`layout-left`). */
export const LayoutLeftIcon = createHugeicon("LayoutLeftIcon", [
  {
    d: "M20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12C2.5 7.52166 2.5 5.28248 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088Z",
    round: true,
  },
  { d: "M9 21.5L9 2.5" },
]);

/** Sidebar on the right, collapsed (`layout-align-left`). */
export const LayoutAlignLeftIcon = createHugeicon("LayoutAlignLeftIcon", [
  { d: ROUNDED_SQUARE, round: true },
  { d: "M8.00488 16.0049L8.00488 8.00488", round: true },
]);

/** Sidebar on the right, open (`layout-right`). */
export const LayoutRightIcon = createHugeicon("LayoutRightIcon", [
  {
    d: "M3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124Z",
    round: true,
  },
  { d: "M15 2.5L15 21.5" },
]);

/** Top panel with an open chevron (`panel-top-open`): the Environment panel toggle. */
export const PanelTopOpenIcon = createHugeicon("PanelTopOpenIcon", [
  {
    d: "M2.49219 12C2.49219 7.52166 2.49219 5.28249 3.88343 3.89124C5.27467 2.5 7.51384 2.5 11.9922 2.5C16.4705 2.5 18.7097 2.5 20.1009 3.89124C21.4922 5.28249 21.4922 7.52166 21.4922 12C21.4922 16.4783 21.4922 18.7175 20.1009 20.1088C18.7097 21.5 16.4705 21.5 11.9922 21.5C7.51384 21.5 5.27467 21.5 3.88343 20.1088C2.49219 18.7175 2.49219 16.4783 2.49219 12Z",
  },
  { d: "M20.9922 9L2.99219 9", round: true },
  { d: "M8.99219 13L11.9922 16L14.9922 13", round: true },
]);
