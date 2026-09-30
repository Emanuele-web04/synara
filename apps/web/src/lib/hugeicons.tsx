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

/** Sidebar on the right, collapsed to a slim handle (`layout-align-right`). */
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

/** Sidebar on the left, collapsed to a slim handle (`layout-align-left`). */
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

/** Plus (`plus-sign`): add actions in the top bar, matching the toggles beside them. */
export const PlusSignIcon = createHugeicon("PlusSignIcon", [
  { d: "M12 4V20M20 12H4", round: true },
]);

/** Expand (`expand`): grow a panel or card to its larger size. */
export const ExpandIcon = createHugeicon("ExpandIcon", [
  {
    d: "M19 12L19 8.99996C19 7.11435 18.9999 6.17155 18.4142 5.58577C17.8284 4.99999 16.8856 4.99999 15 5L12 5.00001",
    round: true,
  },
  {
    d: "M5 12L5.00003 15C5.00004 16.8856 5.00005 17.8284 5.58584 18.4142C6.17163 19 7.11443 19 9.00004 19L12 19",
    round: true,
  },
]);

/** Collapse (`collapse`): return an expanded panel or card to its compact size. */
export const CollapseIcon = createHugeicon("CollapseIcon", [
  {
    d: "M13 4L13 7.00002C13 8.88563 13.0001 9.82843 13.5858 10.4142C14.1716 11 15.1144 11 17 11L20 11",
    round: true,
  },
  {
    d: "M11.0001 20L11 17C11 15.1144 11 14.1715 10.4142 13.5858C9.82843 13 8.88563 13 7.00002 13L4.00006 13",
    round: true,
  },
]);

/** Merged pull request (`workflow-circle-06`): the PR-state glyph for "merged". */
export const WorkflowCircle06Icon = createHugeicon("WorkflowCircle06Icon", [
  {
    d: "M9 5C9 6.65685 7.65685 8 6 8C4.34315 8 3 6.65685 3 5C3 3.34315 4.34315 2 6 2C7.65685 2 9 3.34315 9 5Z",
  },
  {
    d: "M21 14C21 15.6569 19.6569 17 18 17C16.3431 17 15 15.6569 15 14C15 12.3431 16.3431 11 18 11C19.6569 11 21 12.3431 21 14Z",
  },
  {
    d: "M9 19C9 20.6569 7.65685 22 6 22C4.34315 22 3 20.6569 3 19C3 17.3431 4.34315 16 6 16C7.65685 16 9 17.3431 9 19Z",
  },
  { d: "M6 8V16", round: true },
  { d: "M15 14H12C8.68629 14 6 11.3137 6 8", round: true },
]);
